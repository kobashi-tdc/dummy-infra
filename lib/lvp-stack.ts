import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as codebuild from 'aws-cdk-lib/aws-codebuild';

export class LvpStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // ===== Parameters =====
    const connectionArn = new cdk.CfnParameter(this, 'ConnectionArn', {
      type: 'String',
      description: 'CodeStar Connections ARN for GitHub (e.g., arn:aws:codestar-connections:ap-northeast-1:123456789012:connection/xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx)',
    });
    const githubOwner = new cdk.CfnParameter(this, 'GitHubOwner', {
      type: 'String',
      default: 'kobashi-yoshizumi',
    });
    const githubRepo = new cdk.CfnParameter(this, 'GitHubRepo', {
      type: 'String',
      default: 'lvp-example',
    });
    const githubBranch = new cdk.CfnParameter(this, 'GitHubBranch', {
      type: 'String',
      default: 'main',
    });

    // ===== Network =====
    const vpc = new ec2.Vpc(this, 'Vpc', {
      maxAzs: 2,
      natGateways: 0, // コスト最小化。タスクは public IP 付与
      subnetConfiguration: [
        { name: 'public', subnetType: ec2.SubnetType.PUBLIC },
      ],
    });

    // ===== ECR =====
    const repo = new ecr.Repository(this, 'EcrRepo', {
      repositoryName: 'lvp-example',
      imageScanOnPush: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    // ===== ECS / Fargate =====
    const cluster = new ecs.Cluster(this, 'Cluster', {
      vpc,
      clusterName: 'lvp-cluster',
    });

    const taskRole = new iam.Role(this, 'TaskRole', {
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
    });

    const execRole = new iam.Role(this, 'ExecutionRole', {
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AmazonECSTaskExecutionRolePolicy'),
      ],
    });

    const logGroup = new logs.LogGroup(this, 'AppLogGroup', {
      logGroupName: `/ecs/lvp-example`,
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const taskDef = new ecs.FargateTaskDefinition(this, 'TaskDef', {
      family: 'lvp-example-task',
      cpu: 512,
      memoryLimitMiB: 1024,
      taskRole,
      executionRole: execRole,
    });

    const container = taskDef.addContainer('AppContainer', {
      containerName: 'web',
      image: ecs.ContainerImage.fromEcrRepository(repo, 'latest'),
      logging: ecs.LogDrivers.awsLogs({ logGroup, streamPrefix: 'app' }),
      portMappings: [{ containerPort: 8501 }],
      environment: {
        // 必要なら環境変数をここに
      },
    });

    // SG
    const albSg = new ec2.SecurityGroup(this, 'AlbSg', {
      vpc,
      allowAllOutbound: true,
      description: 'ALB SG',
    });
    albSg.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(80), 'HTTP from Internet');

    const svcSg = new ec2.SecurityGroup(this, 'SvcSg', {
      vpc,
      allowAllOutbound: true,
      description: 'Service SG',
    });
    svcSg.addIngressRule(albSg, ec2.Port.tcp(8501), 'ALB -> App 8501');

    // Fargate Service（public IP を付与）
    const service = new ecs.FargateService(this, 'Service', {
      cluster,
      serviceName: 'lvp-service',
      taskDefinition: taskDef,
      desiredCount: 1,
      assignPublicIp: true,
      securityGroups: [svcSg],
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
      minHealthyPercent: 50,
      maxHealthyPercent: 200,
    });

    // ALB + TargetGroup
    const alb = new elbv2.ApplicationLoadBalancer(this, 'Alb', {
      vpc,
      internetFacing: true,
      securityGroup: albSg,
      loadBalancerName: 'lvp-alb',
    });
    const listener = alb.addListener('Http', { port: 80, open: true });

    const tg = listener.addTargets('EcsTg', {
      port: 8501,
      targets: [service],
      healthCheck: {
        path: '/',
        healthyHttpCodes: '200',
        interval: cdk.Duration.seconds(20),
      },
    });

    // ===== CodeBuild =====
    const cbRole = new iam.Role(this, 'CodeBuildRole', {
      assumedBy: new iam.ServicePrincipal('codebuild.amazonaws.com'),
    });
    // ECR push/pull 権限
    repo.grantPullPush(cbRole);
    // ECS 更新関連
    cbRole.addToPolicy(new iam.PolicyStatement({
      actions: [
        'ecs:DescribeClusters',
        'ecs:DescribeServices',
        'ecs:DescribeTaskDefinition',
        'ecs:RegisterTaskDefinition',
        'ecs:UpdateService',
      ],
      resources: ['*'],
    }));
    // Task/Execution Role の PassRole
    cbRole.addToPolicy(new iam.PolicyStatement({
      actions: ['iam:PassRole'],
      resources: [taskRole.roleArn, execRole.roleArn],
    }));
    // ECR 認証
    cbRole.addToPolicy(new iam.PolicyStatement({
      actions: ['ecr:GetAuthorizationToken'],
      resources: ['*'],
    }));
    // CloudWatch Logs 出力
    const cbLogGroup = new logs.LogGroup(this, 'CodeBuildLogGroup', {
      logGroupName: '/codebuild/lvp-example-build',
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const project = new codebuild.Project(this, 'AppBuild', {
      projectName: 'lvp-example-build',
      role: cbRole,
      source: codebuild.Source.connection({
        owner: githubOwner.valueAsString,
        repo: githubRepo.valueAsString,
        connectionArn: connectionArn.valueAsString,
        branchOrRef: githubBranch.valueAsString,
        // アプリ側リポジトリの buildspec.yml を使う
        buildspec: codebuild.BuildSpec.fromSourceFilename('buildspec.yml'),
      }),
      environment: {
        buildImage: codebuild.LinuxBuildImage.STANDARD_7_0,
        privileged: true, // Docker build 用
        computeType: codebuild.ComputeType.SMALL,
      },
      logging: {
        cloudWatch: {
          logGroup: cbLogGroup,
        },
      },
      environmentVariables: {
        IMAGE_REPO_NAME: { value: repo.repositoryName },
        ECS_CLUSTER_NAME: { value: cluster.clusterName },
        ECS_SERVICE_NAME: { value: service.serviceName },
        TASK_FAMILY: { value: taskDef.family },
        CONTAINER_NAME: { value: container.containerName },
        AWS_DEFAULT_REGION: { value: cdk.Stack.of(this).region },
        AWS_ACCOUNT_ID: { value: cdk.Stack.of(this).account },
      },
      // Build バッジなど必要なら追加
    });

    // Webhook トリガ（PUSH のみ、main ブランチ）
    project.enableBatchBuilds(); // 無視しても可（ここでは影響なし）
    project.onEvent('Ignore'); // ダミー（実質不要）

    // CodeBuild の Webhook フィルタ
    new codebuild.ProjectTriggers(this, 'Triggers', {
      project,
      webhook: true,
      filterGroups: [
        [
          codebuild.FilterGroup.inEventOf(codebuild.EventAction.PUSH).andBranchIs(githubBranch.valueAsString),
        ],
      ],
    });

    // ===== Outputs =====
    new cdk.CfnOutput(this, 'AlbDns', { value: alb.loadBalancerDnsName });
    new cdk.CfnOutput(this, 'EcrRepoUri', { value: repo.repositoryUri });
    new cdk.CfnOutput(this, 'CodeBuildProjectName', { value: project.projectName });
    new cdk.CfnOutput(this, 'EcsClusterName', { value: cluster.clusterName });
    new cdk.CfnOutput(this, 'EcsServiceName', { value: service.serviceName });
  }
}
