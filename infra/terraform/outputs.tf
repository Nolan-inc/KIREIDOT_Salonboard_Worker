output "ecr_repository_url" {
  value = aws_ecr_repository.worker.repository_url
}

output "ecs_cluster_name" {
  value = aws_ecs_cluster.main.name
}

output "ecs_service_name" {
  value = aws_ecs_service.worker.name
}

output "task_definition_family" {
  value = aws_ecs_task_definition.worker.family
}

output "public_subnet_ids" {
  value = aws_subnet.public[*].id
}

output "worker_security_group_id" {
  value = aws_security_group.worker.id
}

output "github_deploy_role_arn" {
  value = var.github_repo == "" ? null : aws_iam_role.github_deploy[0].arn
}

output "state_bucket" {
  value = aws_s3_bucket.state.bucket
}

output "debug_bucket" {
  value = aws_s3_bucket.debug.bucket
}
