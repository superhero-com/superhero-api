# Publication database authority

Migration `1791763210000-ShortsPublisherAuthority` adds the scoped
`shorts_publication(text,jsonb)` boundary. It is consumed by
`ShortsPublicationBoundaryService`. The hosted API and isolated publisher use
different database logins. Neither receives direct access to publication-journal
tables or permission to change the configured operator or spending limits.

The hosted API uses this boundary and holds no signing account. The separate
[publication worker](PUBLISHER.md) signs, saves and submits approved requests.
Use the documented coordinated setup when upgrading an existing deployment;
adding the migration alone does not enroll runtime logins or start the worker.
The remaining local-state restrictions still limit the full API to one instance.

Apply migrations through `1791763223000-ShortsPublicationAdmission` before starting
the current API or publisher. This extends the existing function with a capacity
check; startup verifies its capability version. The migration preserves function
ownership, execution grants, search path and journal contents. Its downgrade leaves
saved transactions intact but requires a compatible older runtime.

## Roles

| Enrolled kind | Permitted operations | Excluded authority |
|---|---|---|
| `api` | Verify deployment, check preparation capacity, enqueue a creator's approved video, read that creator's request status | Claim, sign/persist, authorize sending, settle or read raw signed transactions |
| `publisher` | Verify deployment, claim/recover work, persist signed bytes, authorize sending, renew/release claims, record verified outcomes | Enqueue, approve content, change media identity, alter signer policy or directly access application tables |

The API still authenticates creator ownership before calling the boundary; passing
an address to PostgreSQL is not authentication. The function also checks that the
address matches the content owner. Both roles are pinned to one network/contract,
the verified source hash, operator and exact spending policy on every call.
Multiple publisher logins may serve the same contract; lease ownership includes
the actual login OID, token and fence. One operator remains serialized across
contracts by the shared journal account lock.

The capacity operation checks ownership, deployment, current publication policy,
operator pause and operator/creator pending limits. It returns only `ready: true`
or `ready: false`; existing journal entries return false. It creates no reservation
and exposes no queue contents. Concurrent preparation can race for a slot, so final
enqueue repeats the checks under the account lock and rejects a full queue.

## Enrollment

A trusted migration/setup identity initializes the deployment and policy using
`ShortsPublicationsService.initialize`. It must not be the runtime API or signer
login. Then a DBA enrolls dedicated logins in `shorts_publisher_principals` with
their current PostgreSQL OID **and** name, kind, network and contract. Merely
recreating a dropped login with the same name does not restore authority.

Each runtime login needs schema USAGE and EXECUTE on this function. The publisher
needs no application-table privileges. Preserve the API's separately required
ordinary application grants, while excluding all publication journal, policy and
principal tables. A shared table-owner/superuser connection is unsuitable.

For example, after creating restricted `shorts_api` and `shorts_publisher` logins
and initializing the verified contract, the DBA can enroll them in the correct
schema using:

```sql
GRANT USAGE ON SCHEMA public TO shorts_api, shorts_publisher;
GRANT EXECUTE ON FUNCTION public.shorts_publication(text,jsonb)
  TO shorts_api, shorts_publisher;

INSERT INTO public.shorts_publisher_principals
  (role_oid, role_name, kind, network, contract)
SELECT r.oid, r.rolname, v.kind, 'ae_uat', 'ct_REPLACE_WITH_VERIFIED_CONTRACT'
FROM (VALUES ('shorts_api','api'), ('shorts_publisher','publisher')) AS v(name,kind)
JOIN pg_catalog.pg_roles r ON r.rolname=v.name;
```

Use the actual application schema and verified address. Manage passwords through
the deployment's secret system; never put them into this example or source files.
The NestJS setup entrypoint in [PUBLISHER.md](PUBLISHER.md) performs this enrollment.
Starting the separate worker and switching the API login remain deployment steps.

Runtime logins must have LOGIN and no superuser, database/role creation,
replication, RLS bypass, role membership or schema/database CREATE authority.
The boundary rejects accidental table/column grants, ownership, access through
dependent views, and access to other user-defined security-definer functions.
The API may retain ordinary non-journal application access; the publisher may not.
Review existing default grants before enrollment. Excessive-grant detection fails
function calls; it cannot revoke privileges that a DBA grants directly.

## Verification and recovery

Only the enrolled publisher can persist or settle a transaction. The TypeScript
adapter checks real signatures, exact publication calldata, network prefix and
cost bounds before persistence and validates saved bytes again on recovery/send.
The database enforces immutable intent/bytes, lease ownership, queue limits,
configured costs/nonces/TTL and allowed state transitions. PostgreSQL does not
parse and verify Ed25519 transactions or query the node: the isolated runner must
independently verify canonical chain observations before settlement. Protect its
database credentials together with its signing key.

The function has a fixed search path, qualifies application relations, and has
no PUBLIC execution grant. Temporary objects cannot replace its tables. Responses
to the API contain only request ID, status, transaction hash and confirmation block anchor,
or the capacity boolean for preparation checks. Raw signed bytes
remain accessible only to the publisher role and trusted administrative access.

Disabling enrollment immediately rejects further function calls, including a
current claim. A replacement enrolled publisher can recover that claim after its
lease expires. It cannot recall a send already authorized or broadcast. Preserve
the journal and reconcile chain outcomes before resetting accounts, restoring old
backups or removing this boundary. Downgrade refuses active enrollment.

`npm run test:shorts:publisher-authority` uses a disposable loopback PostgreSQL
database in `SHORTS_TEST_PG_URL`, temporary dedicated logins and offline signatures.
It exercises role separation, attempted SQL bypasses, claims, immutable bytes,
policy changes and recovery. It does not establish deployed role configuration,
key custody or live-node finality.
