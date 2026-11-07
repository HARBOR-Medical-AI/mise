/**
 * @file A Resource Manager job's log as a step's log carries it: Terraform's
 * set-up and per-resource refreshes left out, the plan's changes and count
 * kept, the console prefix gone, and an empty read never the word `undefined`.
 */
import { describe, it, expect } from '@jest/globals';
import { jobLogLine_keep } from '../src/cloud/oci/jobLog.js';

const P: string = '2026/11/06 21:42:45[TERRAFORM_CONSOLE] [INFO] ';

describe('a job log line', () => {
  it('leaves out what every Terraform run says, and keeps what this job does', () => {
    const raw: string[] = [
      `${P}`,
      `${P}Initializing provider plugins...`,
      `${P}- Reusing previous version of oracle/oci from the dependency lock file`,
      `${P}- Installed oracle/oci v9.11.0 (signed by a HashiCorp partner, key ID 1533A49284137CEB)`,
      `${P}Partner and community providers are signed by their developers.`,
      `${P}Terraform has been successfully initialized!`,
      `${P}Loading Environment variables from var.env file...`,
      `${P}oci_core_volume.data: Refreshing state... [id=ocid1.volume.oc1.iad.x]`,
      `${P}data.oci_identity_availability_domains.ads: Read complete after 0s [id=x]`,
      `${P}  ~ resource "oci_core_instance" "machine" {`,
      `${P}          ~ boot_volume_size_in_gbs         = "100" -> "150"`,
      `${P}Plan: 0 to add, 1 to change, 0 to destroy.`,
      `${P}Saved the plan to: <path hidden>`,
      `${P}No changes. Your infrastructure matches the configuration.`,
      'undefined',
    ];
    expect(raw.map(jobLogLine_keep).filter((line: string | null): line is string => line !== null)).toEqual([
      '  ~ resource "oci_core_instance" "machine" {',
      '          ~ boot_volume_size_in_gbs         = "100" -> "150"',
      'Plan: 0 to add, 1 to change, 0 to destroy.',
      'No changes. Your infrastructure matches the configuration.',
    ]);
  });

  it('keeps a line that is not Terraform\'s console, and an error', () => {
    expect(jobLogLine_keep('2026/11/06 21:42:45[TERRAFORM_CONSOLE] [ERROR] Error: 409-Conflict')).toBe('Error: 409-Conflict');
    expect(jobLogLine_keep('something the job said')).toBe('something the job said');
  });
});
