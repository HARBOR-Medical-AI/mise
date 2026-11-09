/**
 * @file The berth capacity rule porter's launcher and ARGUS share.
 */
import { describe, it, expect } from '@jest/globals';
import { berthCapacity_derive, profileFloor_get } from '../src/script.js';

const DEFAULT_RULE = { limits: { cpus: 1, memoryGib: 2 }, holds: null };

describe('profileFloor_get', () => {
  it('reads the named profile\'s floor, and the minimal one for a name it does not list', () => {
    expect(profileFloor_get('minimal')).toEqual({ vcpu: 2, memory: 4, data: 50 });
    expect(profileFloor_get()).toEqual({ vcpu: 2, memory: 4, data: 50 });
    expect(profileFloor_get('complete')).toEqual({ vcpu: 2, memory: 4, data: 50 });
    expect(profileFloor_get('nope')).toEqual({ vcpu: 2, memory: 4, data: 50 });
  });
});

describe('berthCapacity_derive', () => {
  const floor = profileFloor_get('minimal');

  it('holds what is left of the host above the floor, the scarcer of CPU and memory deciding', () => {
    expect(berthCapacity_derive({ cpus: 24, memoryGib: 62.7 }, floor, DEFAULT_RULE)).toBe(22);
    expect(berthCapacity_derive({ cpus: 4, memoryGib: 16 }, floor, { limits: { cpus: 1, memoryGib: 4 }, holds: null })).toBe(2);
    expect(berthCapacity_derive({ cpus: 8, memoryGib: 8 }, floor, DEFAULT_RULE)).toBe(2);
  });

  it('holds none when the host has nothing above the floor', () => {
    expect(berthCapacity_derive({ cpus: 2, memoryGib: 4 }, floor, DEFAULT_RULE)).toBe(0);
    expect(berthCapacity_derive({ cpus: 1, memoryGib: 1 }, floor, DEFAULT_RULE)).toBe(0);
  });

  it('takes a policy\'s smaller number, never a larger one', () => {
    expect(berthCapacity_derive({ cpus: 24, memoryGib: 62.7 }, floor, { ...DEFAULT_RULE, holds: 1 })).toBe(1);
    expect(berthCapacity_derive({ cpus: 4, memoryGib: 8 }, floor, { ...DEFAULT_RULE, holds: 10 })).toBe(2);
  });

  it('counts fractional limits', () => {
    expect(berthCapacity_derive({ cpus: 4, memoryGib: 16 }, floor, { limits: { cpus: 0.5, memoryGib: 1.5 }, holds: null })).toBe(4);
  });
});
