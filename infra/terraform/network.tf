data "aws_availability_zones" "available" {
  state = "available"
}

locals {
  azs = slice(data.aws_availability_zones.available.names, 0, 2)
}

resource "aws_vpc" "main" {
  cidr_block           = var.vpc_cidr
  enable_dns_support   = true
  enable_dns_hostnames = true
  tags                 = { Name = "${var.name}-vpc" }
}

resource "aws_internet_gateway" "main" {
  vpc_id = aws_vpc.main.id
  tags   = { Name = "${var.name}-igw" }
}

# SalonBoard 宛の出口 IP は住宅/ISP プロキシ (SB_PROXY_*) が担うため、タスク自身の
# egress IP (データセンター) は問わない。→ NAT GW (固定費 ~$45/月) と EIP プールを
# 廃止し、public subnet + public IP で動かす (元設計の Tier3 EIP ローテも不要)。
resource "aws_subnet" "public" {
  count                   = 2
  vpc_id                  = aws_vpc.main.id
  cidr_block              = cidrsubnet(var.vpc_cidr, 8, count.index)
  availability_zone       = local.azs[count.index]
  map_public_ip_on_launch = true
  tags                    = { Name = "${var.name}-public-${count.index}" }
}

resource "aws_route_table" "public" {
  vpc_id = aws_vpc.main.id
  route {
    cidr_block = "0.0.0.0/0"
    gateway_id = aws_internet_gateway.main.id
  }
  tags = { Name = "${var.name}-public" }
}

resource "aws_route_table_association" "public" {
  count          = 2
  subnet_id      = aws_subnet.public[count.index].id
  route_table_id = aws_route_table.public.id
}

# S3 Gateway Endpoint (無料): storageState/debug の S3 アクセスをインターネット経由に
# しない (egress データ転送料の節約)。
resource "aws_vpc_endpoint" "s3" {
  vpc_id            = aws_vpc.main.id
  service_name      = "com.amazonaws.${var.region}.s3"
  vpc_endpoint_type = "Gateway"
  route_table_ids   = [aws_route_table.public.id]
  tags              = { Name = "${var.name}-s3-endpoint" }
}

# Worker タスク用 SG: egress のみ (inbound 一切なし)
resource "aws_security_group" "worker" {
  name        = "${var.name}-worker"
  description = "SalonBoard worker tasks (egress only)"
  vpc_id      = aws_vpc.main.id

  egress {
    description = "all egress (proxy / Supabase / Admin API)"
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = { Name = "${var.name}-worker" }
}
