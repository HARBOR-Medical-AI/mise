/**
 * @file A VM's two Terraform modules (docs/stratus.adoc, D16), as the store's
 * hand run built it (docs/howto-store-vm.adoc), one stack per lifetime:
 *
 * - **data**: the data volume (balanced, in the first availability domain),
 *   its daily backups when asked (incremental, seven kept), and the reserved
 *   public address. A default teardown keeps this stack, so a rebuilt VM
 *   opens the old data under the old name.
 * - **machine**: the instance (E5.Flex, the image pinned at the first build),
 *   its boot disk, a security group opening the declared ports to the
 *   internet, and the data volume's attachment. The reserved address is
 *   pointed at the instance by the builder after the apply: Terraform has no
 *   resource for an assignment, and the address belongs to the data stack.
 *
 * Every resource carries `mise-service=<name>` and leaves `Oracle-Tags` out
 * of the comparison. The instance's cloud-init installs Docker with its data
 * on the volume (`/srv/data`) and opens the declared ports in the image's
 * own firewall; it carries no secret (user data is readable by anyone who
 * can read the compartment's instances).
 *
 * @module
 */
import { createHash } from 'node:crypto';
import { files_zip } from '../zip.js';

/** The family every VM is made in: AMD, flexible, the cheapest that fits a store (D16: the driver chooses). */
export const VM_SHAPE: string = 'VM.Standard.E5.Flex';

/** The operating systems the OCI driver builds, by the script's word: OCI's name for them. */
export const VM_OS_NAMES: Readonly<Record<string, string>> = { ubuntu: 'Canonical Ubuntu' };

/** The data module's Terraform. */
const DATA_TF: string = `terraform {
  required_providers {
    oci = { source = "oracle/oci" }
  }
}

variable "region" {}
variable "compartment_ocid" {}
variable "vm_name" {}
variable "data_gb" {}
variable "backup" {}

provider "oci" {
  region = var.region
}

locals {
  tags = { "mise-service" = var.vm_name }
  ad   = data.oci_identity_availability_domains.ads.availability_domains[0].name
}

data "oci_identity_availability_domains" "ads" {
  compartment_id = var.compartment_ocid
}

resource "oci_core_volume" "data" {
  availability_domain = local.ad
  compartment_id      = var.compartment_ocid
  display_name        = "\${var.vm_name}-data"
  size_in_gbs         = var.data_gb
  vpus_per_gb         = 10
  freeform_tags       = local.tags
  lifecycle {
    ignore_changes = [defined_tags]
  }
}

resource "oci_core_volume_backup_policy" "daily" {
  count          = var.backup == "daily" ? 1 : 0
  compartment_id = var.compartment_ocid
  display_name   = "\${var.vm_name}-daily"
  freeform_tags  = local.tags
  schedules {
    backup_type       = "INCREMENTAL"
    period            = "ONE_DAY"
    hour_of_day       = 4
    time_zone         = "UTC"
    retention_seconds = 604800
  }
  lifecycle {
    ignore_changes = [defined_tags]
  }
}

resource "oci_core_volume_backup_policy_assignment" "daily" {
  count     = var.backup == "daily" ? 1 : 0
  asset_id  = oci_core_volume.data.id
  policy_id = oci_core_volume_backup_policy.daily[0].id
}

resource "oci_core_public_ip" "address" {
  compartment_id = var.compartment_ocid
  lifetime       = "RESERVED"
  display_name   = var.vm_name
  freeform_tags  = local.tags
  lifecycle {
    ignore_changes = [defined_tags, private_ip_id]
  }
}

output "volume_id" {
  value = oci_core_volume.data.id
}

output "availability_domain" {
  value = local.ad
}

output "public_ip_id" {
  value = oci_core_public_ip.address.id
}

output "public_ip" {
  value = oci_core_public_ip.address.ip_address
}
`;

/** The machine module's Terraform. */
const MACHINE_TF: string = `terraform {
  required_providers {
    oci = { source = "oracle/oci" }
  }
}

variable "region" {}
variable "compartment_ocid" {}
variable "vm_name" {}
variable "availability_domain" {}
variable "subnet_id" {}
variable "vcn_id" {}
variable "image_id" {}
variable "os_name" {}
variable "os_version" {}
variable "shape" {}
variable "ocpus" {}
variable "memory_gb" {}
variable "disk_gb" {}
variable "open_ports" {}
variable "ssh_public_key" {}
variable "user_data" {}
variable "volume_id" {}

provider "oci" {
  region = var.region
}

locals {
  tags  = { "mise-service" = var.vm_name }
  ports = var.open_ports == "" ? [] : split(",", var.open_ports)
  image = var.image_id != "" ? var.image_id : data.oci_core_images.os.images[0].id
}

data "oci_core_images" "os" {
  compartment_id           = var.compartment_ocid
  operating_system         = var.os_name
  operating_system_version = var.os_version
  shape                    = var.shape
  sort_by                  = "TIMECREATED"
  sort_order               = "DESC"
}

resource "oci_core_network_security_group" "open" {
  compartment_id = var.compartment_ocid
  vcn_id         = var.vcn_id
  display_name   = "\${var.vm_name}-open"
  freeform_tags  = local.tags
  lifecycle {
    ignore_changes = [defined_tags]
  }
}

resource "oci_core_network_security_group_security_rule" "open" {
  for_each                  = toset(local.ports)
  network_security_group_id = oci_core_network_security_group.open.id
  direction                 = "INGRESS"
  protocol                  = "6"
  source                    = "0.0.0.0/0"
  source_type               = "CIDR_BLOCK"
  tcp_options {
    destination_port_range {
      min = tonumber(each.value)
      max = tonumber(each.value)
    }
  }
}

resource "oci_core_instance" "machine" {
  availability_domain  = var.availability_domain
  compartment_id       = var.compartment_ocid
  display_name         = var.vm_name
  shape                = var.shape
  preserve_boot_volume = false
  freeform_tags        = local.tags
  shape_config {
    ocpus         = var.ocpus
    memory_in_gbs = var.memory_gb
  }
  source_details {
    source_type             = "image"
    source_id               = local.image
    boot_volume_size_in_gbs = var.disk_gb
  }
  create_vnic_details {
    subnet_id        = var.subnet_id
    assign_public_ip = false
    nsg_ids          = [oci_core_network_security_group.open.id]
    hostname_label   = var.vm_name
    freeform_tags    = local.tags
  }
  metadata = {
    ssh_authorized_keys = var.ssh_public_key
    user_data           = var.user_data
  }
  lifecycle {
    ignore_changes = [defined_tags, create_vnic_details[0].defined_tags, metadata["user_data"]]
  }
}

resource "oci_core_volume_attachment" "data" {
  attachment_type = "paravirtualized"
  instance_id     = oci_core_instance.machine.id
  volume_id       = var.volume_id
  device          = "/dev/oracleoci/oraclevdb"
}

data "oci_core_private_ips" "machine" {
  ip_address = oci_core_instance.machine.private_ip
  subnet_id  = var.subnet_id
}

output "instance_id" {
  value = oci_core_instance.machine.id
}

output "image_id" {
  value = local.image
}

output "private_ip" {
  value = oci_core_instance.machine.private_ip
}

output "private_ip_id" {
  value = data.oci_core_private_ips.machine.private_ips[0].id
}
`;

/** The two modules' zips, made once. */
const zips: { data: Buffer | null; machine: Buffer | null } = { data: null, machine: null };

/**
 * A module as Resource Manager takes it.
 *
 * @param which - The data module or the machine module.
 * @returns The zip.
 */
export function vmModule_zip(which: 'data' | 'machine'): Buffer {
  const made: Buffer = zips[which] ?? files_zip([{ path: 'main.tf', text: which === 'data' ? DATA_TF : MACHINE_TF }]);
  zips[which] = made;
  return made;
}

/**
 * A module's digest: which release of it a stack runs.
 *
 * @param which - The data module or the machine module.
 * @returns The zip's SHA-256, first twelve hex digits.
 */
export function vmModule_digest(which: 'data' | 'machine'): string {
  return createHash('sha256').update(vmModule_zip(which)).digest('hex').slice(0, 12);
}

/**
 * The instance's cloud-init: the data volume formatted once and mounted at
 * `/srv/data`, Docker installed with its data there, the declared ports open
 * in the image's own firewall (Ubuntu on OCI rejects all but SSH), and a
 * marker when all of it stood.
 *
 * @param ports - The ports open to the internet.
 * @returns The cloud-config.
 */
export function vmCloudInit_render(ports: ReadonlyArray<number>): string {
  const open: string[] = ports.map((port: number): string => `  - iptables -I INPUT 5 -p tcp --dport ${port} -m state --state NEW -j ACCEPT`);
  return [
    '#cloud-config',
    'package_update: true',
    'packages: [ca-certificates, curl]',
    'write_files:',
    '  - path: /usr/local/sbin/stratus-data',
    "    permissions: '0755'",
    '    content: |',
    '      #!/bin/sh',
    '      # The data volume: attached after the instance starts, so waited for; formatted only when blank.',
    '      set -e',
    '      dev=/dev/oracleoci/oraclevdb',
    '      for i in $(seq 1 120); do [ -e $dev ] && break; sleep 5; done',
    '      [ -e $dev ] || { echo "stratus: no data volume at $dev" >&2; exit 1; }',
    '      blkid $dev >/dev/null || mkfs.ext4 -q -L data $dev',
    '      mkdir -p /srv/data',
    "      grep -q '^LABEL=data ' /etc/fstab || echo 'LABEL=data /srv/data ext4 defaults,_netdev,nofail 0 2' >> /etc/fstab",
    '      systemctl daemon-reload',
    '      mountpoint -q /srv/data || mount /srv/data',
    '  - path: /etc/docker/daemon.json',
    `    content: '{"data-root": "/srv/data/docker"}'`,
    'runcmd:',
    '  - /usr/local/sbin/stratus-data',
    '  - install -m 0755 -d /etc/apt/keyrings',
    '  - curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc',
    '  - chmod a+r /etc/apt/keyrings/docker.asc',
    '  - . /etc/os-release && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $VERSION_CODENAME stable" > /etc/apt/sources.list.d/docker.list',
    '  - apt-get update',
    '  - DEBIAN_FRONTEND=noninteractive apt-get install -y docker-ce docker-ce-cli containerd.io docker-compose-plugin',
    '  - usermod -aG docker ubuntu',
    ...open,
    '  - netfilter-persistent save',
    '  - mountpoint -q /srv/data && docker info >/dev/null && touch /var/lib/cloud/stratus-ready',
    '',
  ].join('\n');
}

/**
 * The script's `--os` as OCI's image name and version.
 *
 * @param os - `ubuntu-26.04`.
 * @returns `Canonical Ubuntu` and `26.04`, or why the driver builds none of it.
 */
export function vmOs_lower(os: string): { name: string; version: string } | { error: string } {
  const cut: number = os.indexOf('-');
  const word: string = os.slice(0, cut);
  const name: string | undefined = VM_OS_NAMES[word];
  if (name === undefined) return { error: `--os ${os}: the OCI driver builds ${Object.keys(VM_OS_NAMES).join(', ')} only (its cloud-init speaks apt)` };
  return { name, version: os.slice(cut + 1) };
}

/**
 * The data module's inputs.
 *
 * @param request - The VM, where it goes, its data volume and backups.
 * @returns The variables, every value a string.
 */
export function vmDataVariables_build(request: { name: string; region: string; compartmentId: string; data: string; backup: string }): Record<string, string> {
  return { region: request.region, compartment_ocid: request.compartmentId, vm_name: request.name, data_gb: request.data, backup: request.backup };
}

/**
 * The machine module's inputs. vCPUs lower to OCPUs: E5 sells two vCPUs to one.
 *
 * @param request - The VM, where it goes, its size and image, and what the data stack and the network left.
 * @returns The variables, every value a string.
 * @throws Error - When the operating system is not one the driver builds.
 */
export function vmMachineVariables_build(request: { name: string; region: string; compartmentId: string; inputs: Readonly<Record<string, string>> }): Record<string, string> {
  const input = (key: string): string => request.inputs[key] ?? '';
  const os = vmOs_lower(input('os'));
  if ('error' in os) throw new Error(os.error);
  const ports: number[] = input('open') === '' ? [] : input('open').split(',').map(Number);
  return {
    region: request.region,
    compartment_ocid: request.compartmentId,
    vm_name: request.name,
    availability_domain: input('availabilityDomain'),
    subnet_id: input('subnetId'),
    vcn_id: input('vcnId'),
    image_id: input('image'),
    os_name: os.name,
    os_version: os.version,
    shape: VM_SHAPE,
    ocpus: String(Math.max(1, Math.ceil(Number(input('vcpu')) / 2))),
    memory_gb: input('memory'),
    disk_gb: input('disk'),
    open_ports: ports.join(','),
    ssh_public_key: input('sshPublicKey'),
    user_data: Buffer.from(vmCloudInit_render(ports)).toString('base64'),
    volume_id: input('volumeId'),
  };
}
