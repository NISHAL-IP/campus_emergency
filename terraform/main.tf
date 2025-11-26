terraform {
  required_providers {
    azurerm = {
      source  = "hashicorp/azurerm"
      version = "~>3.0"
    }
  }

#  backend "azurerm" {
#    resource_group_name  = "rg-clubportal"
#    storage_account_name = "stclubportalss"
#    container_name       = "tfstate"
#    key                  = "terraform.tfstate"
#  }
}

provider "azurerm" {
  features {}
}

# Create Resource Group
resource "azurerm_resource_group" "rg" {
  name     = "rg-clubportal"
  location = "East US"
}

# Create Storage Account
resource "azurerm_storage_account" "storage" {
  name                     = "stclubportalss"
  resource_group_name      = azurerm_resource_group.rg.name
  location                 = "East US"
  account_tier             = "Standard"
  account_replication_type = "LRS"
}

# Create Static Web App
resource "azurerm_static_web_app" "clubportal" {
  name                = "clubportal-webapp"
  resource_group_name = azurerm_resource_group.rg.name
  location            = "West Europe"
  sku_tier            = "Free"
  sku_size            = "Free"
}
