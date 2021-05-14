[CmdletBinding()]
param (
  [Parameter(Position = 0)]
  [ValidateSet("prod", "dev")]
  [string]
  $env = "prod"
)

$packageVersion = $(node -p "require('./package.json').version")
$gitHash = $(git rev-parse --short HEAD)
$nodeEnv = "production"
$target = "production-stage"

if ($env -eq "dev") {
  $nodeEnv = "development"
  $target = "dev-stage"
}

docker build . --build-arg PACKAGE_VERSION=$packageVersion --build-arg GIT_HASH=$gitHash --build-arg NODE_ENV=$nodeEnv --target $target -t chrisleekr/binance-trading-bot:latest
