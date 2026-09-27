# Packer variables for CloudGaming Hub Windows AMI build
# Usage: packer build -var-file=vars.pkr.hcl windows-gaming-ami.pkr.hcl

# AWS Configuration
aws_region       = "us-east-1"
instance_type    = "g4dn.xlarge"

# AMI Configuration
ami_name        = "cloudgaming-gaming-ami-prod"
ami_description = "Windows Server 2022 with NVIDIA drivers, CloudyPad, Sunshine, and gaming clients for CloudGaming Hub"

# Storage Configuration
root_volume_size = 100  # 100GB for game libraries
ebs_volume_type  = "gp3"

# Base AMI (Windows Server 2022)
base_ami_filter = {
  name  = ["Windows_Server-2022-English-Core-Base-*"]
  owner = ["amazon"]
}
