-- RLS Test Scenarios
-- After running migrations and seed, test clinic isolation

-- Test 1: User from clinic1 should NOT see clinic2's users
-- Set JWT for clinic1 user
SET request.jwt.claims = '{"clinic_id":"CLINIC1_ID_HERE","role":"owner"}';
SELECT id, clinic_id, full_name FROM users;
-- Expected: Only users from clinic1

-- Test 2: User from clinic2 should NOT see clinic1's users
SET request.jwt.claims = '{"clinic_id":"CLINIC2_ID_HERE","role":"owner"}';
SELECT id, clinic_id, full_name FROM users;
-- Expected: Only users from clinic2

-- Test 3: Chairs isolation
SET request.jwt.claims = '{"clinic_id":"CLINIC1_ID_HERE","role":"owner"}';
SELECT id, clinic_id, name FROM chairs;
-- Expected: Only chairs from clinic1

SET request.jwt.claims = '{"clinic_id":"CLINIC2_ID_HERE","role":"owner"}';
SELECT id, clinic_id, name FROM chairs;
-- Expected: Only chairs from clinic2

-- Test 4: Doctors isolation
SET request.jwt.claims = '{"clinic_id":"CLINIC1_ID_HERE","role":"owner"}';
SELECT id, clinic_id FROM doctors;
-- Expected: Only doctors from clinic1
