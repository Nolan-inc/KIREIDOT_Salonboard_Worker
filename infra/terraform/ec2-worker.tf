# ============================================================
# 静的 egress IP の worker ホスト (EC2 + Elastic IP)
# ============================================================
# Decodo 専用ISPプロキシは user/pass 認証だとデータセンター送信元IP(Fargate の
# 動的 public IP)を遮断する (net::ERR_TUNNEL_CONNECTION_FAILED)。固定の EIP を
# Decodo の Whitelisted IPs に登録して IP 認証で通す。
# worker は ECR の同一イメージ (実 Chrome + Xvfb) を docker run する。
# 常時起動はせず SSM run-command で制御起動する (push OFF のまま PC と競合させない。
# カットオーバー時に systemd 常時化する想定)。
# x86_64 固定 (google-chrome が linux/amd64 のみ。イメージも amd64)。

data "aws_ami" "al2023" {
  most_recent = true
  owners      = ["amazon"]
  filter {
    name   = "name"
    values = ["al2023-ami-2023.*-x86_64"]
  }
  filter {
    name   = "architecture"
    values = ["x86_64"]
  }
}

resource "aws_iam_role" "ec2_worker" {
  name = "${var.name}-ec2-worker"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "ec2.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })
}

# SSM run-command / Session Manager (インバウンド SSH 不要にする)
resource "aws_iam_role_policy_attachment" "ec2_worker_ssm" {
  role       = aws_iam_role.ec2_worker.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore"
}

# ECR pull
resource "aws_iam_role_policy_attachment" "ec2_worker_ecr" {
  role       = aws_iam_role.ec2_worker.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonEC2ContainerRegistryReadOnly"
}

# SSM パラメータ (proxy 認証情報 / worker トークン) 読み取り
resource "aws_iam_role_policy" "ec2_worker_params" {
  name = "ssm-params-read"
  role = aws_iam_role.ec2_worker.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect = "Allow"
      Action = ["ssm:GetParameter", "ssm:GetParameters"]
      Resource = [
        aws_ssm_parameter.worker_token.arn,
        aws_ssm_parameter.proxy_username.arn,
        aws_ssm_parameter.proxy_password.arn,
      ]
    }]
  })
}

resource "aws_iam_instance_profile" "ec2_worker" {
  name = "${var.name}-ec2-worker"
  role = aws_iam_role.ec2_worker.name
}

# Decodo に whitelist する固定 egress IP
resource "aws_eip" "ec2_worker" {
  domain = "vpc"
  tags   = { Name = "${var.name}-ec2-worker" }
}

resource "aws_instance" "worker" {
  ami                         = data.aws_ami.al2023.id
  instance_type               = var.ec2_worker_instance_type
  subnet_id                   = aws_subnet.public[0].id
  vpc_security_group_ids      = [aws_security_group.worker.id]
  iam_instance_profile        = aws_iam_instance_profile.ec2_worker.name
  associate_public_ip_address = true

  root_block_device {
    volume_size = 20
    volume_type = "gp3"
  }

  # Docker を入れて worker イメージを pull するだけ (常時起動はしない)。
  user_data = <<-EOF
    #!/bin/bash
    set -eux
    dnf install -y docker
    systemctl enable --now docker
    ECR=972293797066.dkr.ecr.ap-northeast-1.amazonaws.com
    aws ecr get-login-password --region ap-northeast-1 | docker login --username AWS --password-stdin $ECR
    docker pull $ECR/kireidot-sb/salonboard-worker:latest || true
  EOF

  tags = { Name = "${var.name}-worker" }
}

resource "aws_eip_association" "worker" {
  instance_id   = aws_instance.worker.id
  allocation_id = aws_eip.ec2_worker.id
}
