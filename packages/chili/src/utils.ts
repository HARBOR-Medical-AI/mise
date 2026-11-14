/**
 * @file Utils exports for chili
 *
 * This file exports utility functions without triggering the main CLI.
 * Used by other packages like chell to import utilities.
 *
 * @module
 */

/**
 * Re-exports connection initialization from cumin to align duplicate package boundaries.
 */
export { chrisConnection_init } from '@fnndsc/cumin';

