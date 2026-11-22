-- Transfer indexes do not fit 32 bits on every chain (the demo data has 210381588467457), so the flow-edge index is
-- stored as bigint. The flow query sorts the same value as numeric.
SET search_path = olcys, public;

ALTER TABLE flow_edge ALTER COLUMN idx TYPE bigint;
