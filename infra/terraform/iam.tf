# ---- ECS Task Execution Role (イメージ pull / ログ / SSM secret 注入) ----
resource "aws_iam_role" "task_execution" {
  name = "${var.name}-task-execution"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "ecs-tasks.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })
}

resource "aws_iam_role_policy_attachment" "task_execution_managed" {
  role       = aws_iam_role.task_execution.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

resource "aws_iam_role_policy" "task_execution_ssm" {
  name = "ssm-read"
  role = aws_iam_role.task_execution.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect = "Allow"
      Action = ["ssm:GetParameters"]
      Resource = [
        aws_ssm_parameter.worker_token.arn,
        aws_ssm_parameter.proxy_username.arn,
        aws_ssm_parameter.proxy_password.arn,
      ]
    }]
  })
}

# ---- ECS Task Role (worker プロセス自身の権限: S3 state/debug, メトリクス) ----
resource "aws_iam_role" "task" {
  name = "${var.name}-task"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "ecs-tasks.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })
}

resource "aws_iam_role_policy" "task_s3" {
  name = "s3-state-debug"
  role = aws_iam_role.task.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Action = ["s3:GetObject", "s3:PutObject"]
        Resource = [
          "${aws_s3_bucket.state.arn}/*",
          "${aws_s3_bucket.debug.arn}/*",
        ]
      },
      {
        Effect   = "Allow"
        Action   = ["cloudwatch:PutMetricData"]
        Resource = "*"
        Condition = {
          StringEquals = { "cloudwatch:namespace" = "KireidotSalonboardWorker" }
        }
      },
    ]
  })
}

# ---- GitHub Actions OIDC デプロイロール (長期キー不使用) ----
# アカウントに OIDC プロバイダが未作成だったため Terraform 管理で作成する。
# thumbprint は 2023 年以降 AWS 側でGitHub のルート CA を信頼するため実質未使用だが、
# API 上必須のためプレースホルダを渡す。
resource "aws_iam_openid_connect_provider" "github" {
  count           = var.github_repo == "" ? 0 : 1
  url             = "https://token.actions.githubusercontent.com"
  client_id_list  = ["sts.amazonaws.com"]
  thumbprint_list = ["ffffffffffffffffffffffffffffffffffffffff"]
}

resource "aws_iam_role" "github_deploy" {
  count = var.github_repo == "" ? 0 : 1
  name  = "${var.name}-github-deploy"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Federated = aws_iam_openid_connect_provider.github[0].arn }
      Action    = "sts:AssumeRoleWithWebIdentity"
      Condition = {
        StringEquals = { "token.actions.githubusercontent.com:aud" = "sts.amazonaws.com" }
        StringLike   = { "token.actions.githubusercontent.com:sub" = "repo:${var.github_repo}:*" }
      }
    }]
  })
}

resource "aws_iam_role_policy" "github_deploy" {
  count = var.github_repo == "" ? 0 : 1
  name  = "deploy"
  role  = aws_iam_role.github_deploy[0].id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect   = "Allow"
        Action   = ["ecr:GetAuthorizationToken"]
        Resource = "*"
      },
      {
        Effect = "Allow"
        Action = [
          "ecr:BatchCheckLayerAvailability", "ecr:PutImage",
          "ecr:InitiateLayerUpload", "ecr:UploadLayerPart", "ecr:CompleteLayerUpload",
          "ecr:BatchGetImage", "ecr:GetDownloadUrlForLayer",
        ]
        Resource = aws_ecr_repository.worker.arn
      },
      {
        Effect = "Allow"
        Action = [
          "ecs:DescribeTaskDefinition", "ecs:RegisterTaskDefinition",
          "ecs:DescribeServices", "ecs:UpdateService",
        ]
        Resource = "*"
      },
      {
        Effect   = "Allow"
        Action   = ["iam:PassRole"]
        Resource = [aws_iam_role.task_execution.arn, aws_iam_role.task.arn]
      },
    ]
  })
}
