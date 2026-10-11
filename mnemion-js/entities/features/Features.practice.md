- add a feature: A feature owns each registry contribution in one manifest and is included in the composed registry.
  when: explicit
  step: create a folder under entities/features with the manifest and its schema, hooks, and security contributions as needed
    leaves: a co-located feature declaration
  step: add one import to the FEATURES barrel in index.ts
    leaves: the composed registries include the feature
  step: run the feature tests, npm run coherence:spec, and the policy and effects totality tests
    leaves: green checks for the feature and its boundaries
  pitfall: the write-class cast let a misspelled policy class escape until review (67f5574)
  learned: acf92f8, 67f5574
  because: each separate registry edit is a place a feature can silently omit an effect, route, or write policy
