-- No-op reverse: restoring the prior function body is not worth shipping;
-- re-apply the previous migration's function file if a true rollback is needed.
SELECT 1;
