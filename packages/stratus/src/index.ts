/**
 * @file `@fnndsc/stratus`: a mise session over the cloud substrate a Trusted
 * Domain runs on. One backend, clouds as drivers, OCI first
 * (docs/stratus.adoc).
 *
 * @module
 */
export * from './cloud/driver.js';
export { FakeDriver, fakeCloud_sample, availabilityKey_make, type FakeCloud } from './cloud/fake/driver.js';
export { OciDriver, ociTags_flatten, shape_convert, type OciDriverOptions } from './cloud/oci/driver.js';
export { ociApi_make, type OciApi, type OciApiOptions, type OciCompartmentRecord, type OciLimitValueRecord, type OciShapeRecord, type OciTenancyRecord } from './cloud/oci/api.js';
export { SHAPE_TERMS, familyName_derive, shapeTerms_get, partPrices_index, shapePrices_map, ociPrices_read, PRICE_LIST_URL, type ShapeTerms, type JsonFetch } from './cloud/oci/prices.js';
export { TenancyProvider, TENANCY_RESERVED, CONTAINER_RESERVED, READ_ONLY_REASON, type TenancyProviderOptions } from './vfs/tenancy.js';
export { stratusListingLook, stratusName_colorize, STRATUS_ITEM_KINDS, CONTAINER_TYPES } from './vfs/look.js';
export { StratusSession, configDir_default, type StratusSessionOptions } from './session.js';
export { stratusBackend_make, type StratusBackend, type StratusBackendOptions } from './backend.js';
export { ClusterStore, clustersRoot_derive, clustersRoot_settle, CLUSTER_NAME, type ClusterRecord, type StepRecord, type BuiltStepState } from './cluster/state.js';
export { SPEC_DEFAULT, specYaml_parse, specYaml_render, specOptions_apply, specNodes_build, type ClusterSpec, type NodePool, type ChrisSizing, type SpecNode } from './cluster/spec.js';
export { BUILD_STEPS, STEPS_WRITTEN, FIRST_BILLING_STEP, STEPS_SOURCE, BUILD_WAITS, buildRun_make, buildJob_id, stepNext_find, type BuildDeps } from './cluster/steps.js';
export { plan_count, planCounts_alter, planCounts_words, type PlanCounts, type CloudBuilder, type InfraPlan, type PlanRow, type PreflightCheck, type InfraOutputs, type BuildCall } from './cloud/builder.js';
export { FakeBuildWorld, FakeCloudBuilder, FakeInstaller } from './cloud/fake/builder.js';
export type { Installer, InstallerHost, InstallStatus, PlatformManifest } from './installer/installer.js';
export { AnswerCache } from './cache.js';
export { segments_assign, segment_resolve, idSuffix_extract, ambiguity_words, type Named, type Segment, type SegmentMatch } from './names.js';
export { stratusArgs_parse, type StratusArgs } from './args.js';
export { stratusSegments_build, cluster_parse, STRATUS_SEGMENT_KEYS } from './prompt.js';
