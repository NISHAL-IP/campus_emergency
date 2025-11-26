output "resource_group_name" {
  value = azurerm_resource_group.rg.name
}

output "storage_account_name" {
  value = azurerm_storage_account.storage.name
}

output "static_web_app_url" {
  value = azurerm_static_web_app.clubportal.default_host_name
}
