data "aws_caller_identity" "current" {}

# storageState (shop ごとのログインセッション)。Phase 1 で worker から R/W
resource "aws_s3_bucket" "state" {
  bucket = "${var.name}-worker-state-${data.aws_caller_identity.current.account_id}"
}

resource "aws_s3_bucket_versioning" "state" {
  bucket = aws_s3_bucket.state.id
  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "state" {
  bucket = aws_s3_bucket.state.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "aws:kms"
    }
    bucket_key_enabled = true
  }
}

resource "aws_s3_bucket_public_access_block" "state" {
  bucket                  = aws_s3_bucket.state.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

# debug capture (PII マスク済みスナップショット)。14 日で自動削除
resource "aws_s3_bucket" "debug" {
  bucket = "${var.name}-worker-debug-${data.aws_caller_identity.current.account_id}"
}

resource "aws_s3_bucket_lifecycle_configuration" "debug" {
  bucket = aws_s3_bucket.debug.id
  rule {
    id     = "expire-14d"
    status = "Enabled"
    filter {}
    expiration {
      days = 14
    }
  }
}

resource "aws_s3_bucket_public_access_block" "debug" {
  bucket                  = aws_s3_bucket.debug.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_ecr_repository" "worker" {
  name = "${var.name}/salonboard-worker"

  image_scanning_configuration {
    scan_on_push = true
  }
}

resource "aws_ecr_lifecycle_policy" "worker" {
  repository = aws_ecr_repository.worker.name
  policy = jsonencode({
    rules = [{
      rulePriority = 1
      description  = "keep last 10 images"
      selection = {
        tagStatus   = "any"
        countType   = "imageCountMoreThan"
        countNumber = 10
      }
      action = { type = "expire" }
    }]
  })
}

# Worker 認証トークン (central-dev/cloud モード)。値は terraform 管理外:
#   aws ssm put-parameter --name /kireidot/worker/SALONBOARD_WORKER_TOKEN \
#     --type SecureString --value '<token>' --overwrite
resource "aws_ssm_parameter" "worker_token" {
  name  = "/kireidot/worker/SALONBOARD_WORKER_TOKEN"
  type  = "SecureString"
  value = "CHANGE_ME"

  lifecycle {
    ignore_changes = [value]
  }
}

# Akamai カナリア用: テスト店舗の SalonBoard 認証情報 (Admin/ジョブキュー非依存)。
#   aws ssm put-parameter --name /kireidot/worker/CANARY_LOGIN_ID --type SecureString --value '<id>' --overwrite
#   aws ssm put-parameter --name /kireidot/worker/CANARY_PASSWORD --type SecureString --value '<pw>' --overwrite
resource "aws_ssm_parameter" "canary_login_id" {
  name  = "/kireidot/worker/CANARY_LOGIN_ID"
  type  = "SecureString"
  value = "CHANGE_ME"

  lifecycle {
    ignore_changes = [value]
  }
}

resource "aws_ssm_parameter" "canary_password" {
  name  = "/kireidot/worker/CANARY_PASSWORD"
  type  = "SecureString"
  value = "CHANGE_ME"

  lifecycle {
    ignore_changes = [value]
  }
}
