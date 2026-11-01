/**
 * @file The network's Terraform module (docs/stratus.adoc, D16): what a
 * `net new <name> --cidr` line lowers to on OCI, as the store's hand run
 * built it (docs/howto-store-vm.adoc): a VCN, an internet gateway as the
 * default route, the default security list narrowed to SSH from inside the
 * network (where the bastion's endpoint sits) and the path-MTU ICMP, one
 * public subnet (the range's first /24), and the OCI Bastion on it admitting
 * only the mise bastion's address. Web traffic is a VM's own security group,
 * never the network's.
 *
 * The stack is made in the network's compartment, so every resource is
 * made there too, and each carries `mise-net=<name>`. The tags the tenancy
 * adds itself (`Oracle-Tags`) are left out of every comparison, so a re-plan
 * of a network nobody changed reads nothing to do. Nothing here is in
 * Oracle's price list.
 *
 * @module
 */
import { createHash } from 'node:crypto';
import { files_zip } from '../zip.js';
import { subnet_derive } from '../../../net/spec.js';

/** The module's Terraform, one file. */
const MAIN_TF: string = `terraform {
  required_providers {
    oci = { source = "oracle/oci" }
  }
}

variable "region" {}
variable "compartment_ocid" {}
variable "net_name" {}
variable "cidr" {}
variable "subnet_cidr" {}
variable "dns_label" {}
variable "bastion_name" {}
variable "client_cidr" {}

provider "oci" {
  region = var.region
}

locals {
  tags = { "mise-net" = var.net_name }
}

resource "oci_core_vcn" "net" {
  compartment_id = var.compartment_ocid
  cidr_blocks    = [var.cidr]
  display_name   = var.net_name
  dns_label      = var.dns_label
  freeform_tags  = local.tags
  lifecycle {
    ignore_changes = [defined_tags]
  }
}

resource "oci_core_internet_gateway" "gateway" {
  compartment_id = var.compartment_ocid
  vcn_id         = oci_core_vcn.net.id
  enabled        = true
  display_name   = "\${var.net_name}-gateway"
  freeform_tags  = local.tags
  lifecycle {
    ignore_changes = [defined_tags]
  }
}

resource "oci_core_default_route_table" "default" {
  manage_default_resource_id = oci_core_vcn.net.default_route_table_id
  freeform_tags              = local.tags
  lifecycle {
    ignore_changes = [defined_tags]
  }
  route_rules {
    destination       = "0.0.0.0/0"
    destination_type  = "CIDR_BLOCK"
    network_entity_id = oci_core_internet_gateway.gateway.id
  }
}

resource "oci_core_default_security_list" "default" {
  manage_default_resource_id = oci_core_vcn.net.default_security_list_id
  freeform_tags              = local.tags
  lifecycle {
    ignore_changes = [defined_tags]
  }
  egress_security_rules {
    destination = "0.0.0.0/0"
    protocol    = "all"
  }
  ingress_security_rules {
    protocol = "6"
    source   = var.cidr
    tcp_options {
      min = 22
      max = 22
    }
  }
  ingress_security_rules {
    protocol = "1"
    source   = "0.0.0.0/0"
    icmp_options {
      type = 3
      code = 4
    }
  }
  ingress_security_rules {
    protocol = "1"
    source   = var.cidr
    icmp_options {
      type = 3
    }
  }
}

resource "oci_core_subnet" "public" {
  compartment_id             = var.compartment_ocid
  vcn_id                     = oci_core_vcn.net.id
  cidr_block                 = var.subnet_cidr
  display_name               = "\${var.net_name}-public"
  dns_label                  = "public"
  prohibit_public_ip_on_vnic = false
  route_table_id             = oci_core_vcn.net.default_route_table_id
  security_list_ids          = [oci_core_vcn.net.default_security_list_id]
  freeform_tags              = local.tags
  lifecycle {
    ignore_changes = [defined_tags]
  }
}

resource "oci_bastion_bastion" "shell" {
  bastion_type                 = "STANDARD"
  compartment_id               = var.compartment_ocid
  target_subnet_id             = oci_core_subnet.public.id
  name                         = var.bastion_name
  client_cidr_block_allow_list = [var.client_cidr]
  max_session_ttl_in_seconds   = 10800
  freeform_tags                = local.tags
  lifecycle {
    ignore_changes = [defined_tags]
  }
}

output "vcn_id" {
  value = oci_core_vcn.net.id
}

output "subnet_id" {
  value = oci_core_subnet.public.id
}

output "bastion_id" {
  value = oci_bastion_bastion.shell.id
}
`;

/** The module's zip, made once. */
let zip: Buffer | null = null;

/**
 * The module as Resource Manager takes it.
 *
 * @returns The zip.
 */
export function netModule_zip(): Buffer {
  if (zip === null) zip = files_zip([{ path: 'main.tf', text: MAIN_TF }]);
  return zip;
}

/**
 * The module's digest: which release of it a stack runs.
 *
 * @returns The zip's SHA-256, first twelve hex digits.
 */
export function netModule_digest(): string {
  return createHash('sha256').update(netModule_zip()).digest('hex').slice(0, 12);
}

/**
 * A name in the letters OCI's DNS labels and bastion names allow: letters and digits.
 *
 * @param name - The network's name.
 * @param most - How long it may be.
 * @returns `chrisprojectser` for `chrisproject-services` at 15.
 */
function label_derive(name: string, most: number): string {
  return name.replace(/[^a-z0-9]/g, '').slice(0, most);
}

/**
 * The module's inputs for a network.
 *
 * @param request - The network, its range, where it goes and whom the bastion admits.
 * @returns The variables, every value a string.
 */
export function netVariables_build(request: { name: string; cidr: string; region: string; compartmentId: string; clientCidr: string }): Record<string, string> {
  return {
    region: request.region,
    compartment_ocid: request.compartmentId,
    net_name: request.name,
    cidr: request.cidr,
    subnet_cidr: subnet_derive(request.cidr),
    dns_label: label_derive(request.name, 15),
    bastion_name: label_derive(request.name, 64),
    client_cidr: request.clientCidr,
  };
}

