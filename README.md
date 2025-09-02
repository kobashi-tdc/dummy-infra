# lvp-infra-configurator
インフラ構成変更


検証用デプロイ方法

# (A) lvp-infra-configurator を CloudShell に展開
git clone https://github.com/kose-aws-lvp/lvp-infra-configurator.git
cd lvp-infra-configurator
npm i

# CDK 初回のみ
npx cdk bootstrap

# デプロイ（ConnectionArn は控えた ARN に置換）
npx cdk deploy \
  -c aws:cdk:enable-path-metadata=true \
  --parameters ConnectionArn=arn:aws:codestar-connections:ap-northeast-1:<ACCOUNT_ID>:connection/<UUID> \
  --parameters GitHubOwner=<GitHubのオーナー名> \
  --parameters GitHubRepo=lvp-example \
  --parameters GitHubBranch=main
