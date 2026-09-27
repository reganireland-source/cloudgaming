# Packer variables for CloudGaming Hub Windows AMI build
# Primary region: AWS Singapore (ap-southeast-1) for low latency and Oracle egress parity
# Usage: packer build -var-file=vars.pkr.hcl windows-gaming-ami.pkr.hcl

# AWS Configuration - SINGAPORE PRIMARY
aws_region       = "ap-southeast-1"  # Singapore - lowest latency to APAC users
instance_type    = "g4dn.xlarge"      # NVIDIA T4 GPU, 4 vCPU, 16GB RAM

# AMI Configuration
ami_name        = "cloudgaming-gaming-ami-sg-${formatdate("YYYY-MM-DD-hhmm", timestamp())}"
ami_description = "Windows Server 2022 with NVIDIA drivers, CloudyPad, Sunshine, and gaming clients for CloudGaming Hub - Singapore Build"

# Storage Configuration
root_volume_size = 100  # 100GB for game libraries + OS
ebs_volume_type  = "gp3"
ebs_iops         = 3000
ebs_throughput   = 125

# Base AMI (Windows Server 2022)
base_ami_filter = {
  name  = ["Windows_Server-2022-English-Core-Base-*"]
  owner = ["amazon"]
}

# Build metadata
tags_all = {
  Region        = "ap-southeast-1"
  Environment   = "production"
  BuildDate     = timestamp()
  Builder       = "Packer"
  Purpose       = "CloudGaming Hub - Gaming Infrastructure"
  CostOptimized = "true"  # Built for cost-efficiency with Oracle egress parity
}
