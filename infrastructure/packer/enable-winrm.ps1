# Enable WinRM for Packer provisioning on Windows

# Run as system user
Write-Host "Enabling WinRM for Packer..."

# Enable WinRM service
Start-Service WinRM

# Configure WinRM listener
$selectors = @{
    Transport = "HTTP"
    Address   = "*"
}

$options = @{
    OptionSet = @{
        "ALLOW_UNENCRYPTED" = "true"
    }
}

# Create HTTP listener
New-WSManInstance -ResourceURI "winrm/config/Listener" -SelectorSet $selectors -OptionSet $options -ErrorAction SilentlyContinue

# Configure firewall
New-NetFirewallRule -DisplayName "WinRM HTTP" -Direction Inbound -Action Allow -Protocol TCP -LocalPort 5985 -ErrorAction SilentlyContinue

# Set WinRM options
Set-WSManInstance -ResourceURI "winrm/config" -ValueSet @{MaxEnvelopeSizekb = "512000"} -ErrorAction SilentlyContinue
Set-WSManInstance -ResourceURI "winrm/config/Service" -ValueSet @{AllowUnencrypted = "true"} -ErrorAction SilentlyContinue

Write-Host "WinRM enabled and configured for Packer"
