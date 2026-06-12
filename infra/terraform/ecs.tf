resource "aws_cloudwatch_log_group" "worker" {
  name              = "/ecs/${var.name}-worker"
  retention_in_days = 30
}

resource "aws_ecs_cluster" "main" {
  name = "${var.name}-cluster"

  setting {
    name  = "containerInsights"
    value = "enabled"
  }
}

resource "aws_ecs_cluster_capacity_providers" "main" {
  cluster_name       = aws_ecs_cluster.main.name
  capacity_providers = ["FARGATE", "FARGATE_SPOT"]

  # Spot 優先 (weight 4)、ただし最低 1 タスクは On-Demand (base 1) で常時生存
  default_capacity_provider_strategy {
    capacity_provider = "FARGATE"
    base              = 1
    weight            = 1
  }
  default_capacity_provider_strategy {
    capacity_provider = "FARGATE_SPOT"
    weight            = 4
  }
}

resource "aws_ecs_task_definition" "worker" {
  family                   = "${var.name}-worker"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = var.worker_cpu
  memory                   = var.worker_memory
  execution_role_arn       = aws_iam_role.task_execution.arn
  task_role_arn            = aws_iam_role.task.arn

  runtime_platform {
    operating_system_family = "LINUX"
    cpu_architecture        = "X86_64"
  }

  container_definitions = jsonencode([{
    name      = "worker"
    image     = "${aws_ecr_repository.worker.repository_url}:latest"
    essential = true
    # Spot 中断の 2 分猶予をフルに使い、実行中ジョブを drain してから終了する
    stopTimeout = 120

    environment = [
      { name = "KIREIDOT_API_URL", value = var.kireidot_api_url },
      { name = "WORKER_MODE", value = "central-dev" },
      { name = "POLL_INTERVAL_MS", value = tostring(var.poll_interval_ms) },
      { name = "WORKER_CAPABILITIES", value = "headless_chromium" },
      { name = "SALONBOARD_ENABLE_PUSH", value = var.enable_push ? "1" : "false" },
      { name = "SALONBOARD_DEBUG_CAPTURE", value = "1" },
      { name = "STATE_S3_BUCKET", value = aws_s3_bucket.state.bucket },
      { name = "DEBUG_S3_BUCKET", value = aws_s3_bucket.debug.bucket },
    ]

    secrets = [{
      name      = "SALONBOARD_WORKER_TOKEN"
      valueFrom = aws_ssm_parameter.worker_token.arn
    }]

    linuxParameters = { initProcessEnabled = false } # entrypoint が exec node で PID1 を渡す

    logConfiguration = {
      logDriver = "awslogs"
      options = {
        awslogs-group         = aws_cloudwatch_log_group.worker.name
        awslogs-region        = var.region
        awslogs-stream-prefix = "worker"
      }
    }
  }])
}

# Akamai カナリア (Phase 0): Admin/ジョブキューに触れない読み取り専用ループ。
# Service は作らず `aws ecs run-task` で 1 個だけ手動起動する (docs/aws-migration.md)。
resource "aws_ecs_task_definition" "canary" {
  family                   = "${var.name}-canary"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = var.worker_cpu
  memory                   = var.worker_memory
  execution_role_arn       = aws_iam_role.task_execution.arn
  task_role_arn            = aws_iam_role.task.arn

  runtime_platform {
    operating_system_family = "LINUX"
    cpu_architecture        = "X86_64"
  }

  container_definitions = jsonencode([{
    name        = "canary"
    image       = "${aws_ecr_repository.worker.repository_url}:latest"
    essential   = true
    stopTimeout = 120

    environment = [
      { name = "CANARY_MODE", value = "1" },
      { name = "CANARY_INTERVAL_MS", value = "300000" },
      { name = "CANARY_SHOP_LABEL", value = "phase0-canary" },
    ]

    secrets = [
      { name = "SALONBOARD_LOGIN_ID", valueFrom = aws_ssm_parameter.canary_login_id.arn },
      { name = "SALONBOARD_PASSWORD", valueFrom = aws_ssm_parameter.canary_password.arn },
    ]

    logConfiguration = {
      logDriver = "awslogs"
      options = {
        awslogs-group         = aws_cloudwatch_log_group.worker.name
        awslogs-region        = var.region
        awslogs-stream-prefix = "canary"
      }
    }
  }])
}

resource "aws_ecs_service" "worker" {
  name            = "${var.name}-worker"
  cluster         = aws_ecs_cluster.main.id
  task_definition = aws_ecs_task_definition.worker.arn
  desired_count   = var.service_desired_count

  capacity_provider_strategy {
    capacity_provider = "FARGATE"
    base              = 1
    weight            = 1
  }
  capacity_provider_strategy {
    capacity_provider = "FARGATE_SPOT"
    weight            = 4
  }

  network_configuration {
    subnets          = aws_subnet.private[*].id
    security_groups  = [aws_security_group.worker.id]
    assign_public_ip = false
  }

  # CI が update-service するため task_definition の差分は無視
  lifecycle {
    ignore_changes = [task_definition, desired_count]
  }
}
