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

output "private_subnet_ids" {
  value = aws_subnet.private[*].id
}

output "worker_security_group_id" {
  value = aws_security_group.worker.id
}

output "nat_egress_ip" {
  description = "SalonBoard から見える固定 egress IP"
  value       = aws_eip.nat.public_ip
}

output "spare_eips" {
  description = "Tier3 IP ローテーション用予備 EIP"
  value       = aws_eip.spare[*].public_ip
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
