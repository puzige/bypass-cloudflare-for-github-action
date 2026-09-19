# Scoped Cloudflare bypass for GitHub Actions

Fork of [xiaotianxt/bypass-cloudflare-for-github-action](https://github.com/xiaotianxt/bypass-cloudflare-for-github-action). This version keeps the original input names and opt-in defaults, adds optional Browser Integrity Check (BIC) skipping and hostname/path restrictions, and replaces the composite shell implementation with a dependency-free Node 24 main/post action.

## Usage

Build your artifact **before** starting the bypass. Use this action immediately before the network operation. GitHub runs cleanup at the end of the job, not immediately after the next step.

```yaml
permissions:
  contents: read

# Serialize ALL jobs using these Cloudflare resources; see limitations below.
concurrency:
  group: cloudflare-bypass-example-account
  cancel-in-progress: false

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      # Build and push image here, before enabling bypass.
      - uses: puzige/bypass-cloudflare-for-github-action@main
        # Replace main with a reviewed full commit SHA before production use.
        with:
          cf_account_id: ${{ vars.CF_ACCOUNT_ID }}
          cf_zone_id: ${{ vars.CF_ZONE_ID }}
          cf_api_token: ${{ secrets.CF_API_TOKEN }}
          hostname: admin.example.com
          path_prefix: /api/
          skip_bic: 'true'
          disable_bot_fight_mode: 'true'
          bfm_propagation_delay: '10'
      - name: Call deployment API
        env:
          DEPLOY_API_KEY: ${{ secrets.DEPLOY_API_KEY }}
        run: >-
          curl -4 --fail --silent --show-error --max-time 30
          -H "x-api-key: $DEPLOY_API_KEY"
          https://admin.example.com/api/status
```

Use an appropriate authenticated deployment request instead of the example read-only status call. Pin the action to a reviewed commit SHA. Do not run this action on untrusted pull request code with secrets.

## Inputs

| Input | Default | Meaning |
| --- | --- | --- |
| `cf_account_id` | required | Account containing the IP list |
| `cf_zone_id` | required | Zone containing the temporary rule |
| `cf_api_token` | required | Scoped Cloudflare API token |
| `disable_bot_fight_mode` | `false` | Temporarily disable **zone-wide** BFM; requires serialization |
| `bfm_propagation_delay` | `10` | Integer seconds (0–300) after disabling BFM |
| `skip_bic` | `false` | Include `bic` in skip products |
| `hostname` | empty | Exact DNS hostname, not URL or wildcard |
| `path_prefix` | empty | Literal path prefix starting with `/`; no query, fragment or escaping |

The skip rule always requires **both shared-list membership and this runner's exact IP**, plus any supplied hostname and path. Path matching is prefix matching: `/api` also matches `/apix`; use `/api/` if appropriate. Empty hostname/path inputs preserve a broad scope for the current runner. The rule skips remaining custom rules, managed WAF, rate limiting and Super Bot Fight Mode, matching the upstream protection categories; BIC is additionally skipped only when opted in.

Regular Bot Fight Mode is **not** bypassed by a WAF skip rule. Its opt-in toggle affects the **whole zone**, regardless of the hostname/path inputs. This is not a per-request BFM exception.

## Token permissions

- Account → Account Rule Lists → Edit (API permission: `Account Rule Lists Write`; sometimes shown as Account Filter Lists), limited to the chosen account.
- Zone → Zone WAF → Edit, limited to the chosen zone.
- Only with `disable_bot_fight_mode: 'true'`: Zone → Bot Management → Edit and Zone → Zone → Read, limited to the chosen zone.

Unlike upstream's setup-only rule, this fork creates and removes a temporary rule **on every run**, so Zone WAF Edit must remain available every run. Other compatibility changes: preexisting runner IPs are rejected instead of borrowed; legacy broad rules fail closed; BFM opt-in requires BFM initially enabled. This is input-compatible, not behavior-identical.

## Cleanup and recovery

The Node action declares a post handler before main runs. Non-secret state (unique ownership marker, original BFM booleans, list operation ID) is saved before mutations where possible. Main failure immediately attempts cleanup; post retries it. Cleanup restores BFM first, verifies `fight_mode` and `enable_js`, then deletes only its own exact temporary rule and IP item IDs. Foreign list entries/rules are never cleared. Rule expressions modified during the job require manual review rather than deletion. The shared list and an empty ruleset, if created, remain reusable.

Requests have timeouts; HTTP errors and Cloudflare `success: false` fail the action. Async list operations are polled, paginated item reads are supported, and BFM restoration has bounded retries/readback. Write responses lost in transit are recovered using unique comments/descriptions where possible. An unresolved async write remains an error with retry state, never a claimed success. API completion does not guarantee global edge propagation; use a bounded retry of your own **safe/read-only** connectivity check before a non-idempotent deployment request.

**No post handler can guarantee recovery after runner loss, forced cancellation, or Cloudflare API failure.** For unattended production, use independent monitoring/recovery. On failure:

1. Verify and restore BFM to the pre-run settings (`fight_mode` and `enable_js`) first.
2. Inspect the custom rule with the run's `scoped-gha:<UUID>` description; remove it only after verifying ownership.
3. Inspect the shared list and remove only items with that exact comment. Never empty the whole list.
4. Do not start another BFM-changing run until restoration is confirmed.

The action logs no tokens or API response bodies. GitHub action state contains no API credentials.

## Concurrency and migration

- Serialize callers sharing the Cloudflare account/list, including initial list/ruleset creation: Cloudflare permits only one pending bulk list operation per account. Busy API failures fail closed rather than replaying uncertain writes.
- **BFM-changing jobs must never overlap within a zone**, even across repositories. GitHub `concurrency` only coordinates within one repository: multiple repositories need a shared deployment coordinator/lock. Refusing an already-disabled BFM is a safety check, not a distributed lock; two simultaneous reads can still race.
- Jobs sharing a public egress IP must be serialized. An existing matching address or subnet is rejected without modification. Ownership markers protect distinct existing entries, but are not a concurrency guarantee.
- Uses `https://api.ipify.org` for IPv4 egress detection, with no Cloudflare token sent to that service. The deployment request must use the same egress/family (e.g. `curl -4`); changing VPN/proxy/network between steps invalidates the exception.
- Reuses the upstream list name `bypass_cloudflare_for_github_action_list` to avoid consuming another list quota. An active broad legacy rule referencing that list must be reviewed and manually removed/disabled before using this fork. The action will not delete or silently narrow someone else's rule.
- A spare custom rule slot and list item quota are needed. This action changes Cloudflare WAF/BFM settings, but does not change server firewall rules, listening ports, or application deployments.
- Use a current GitHub-hosted runner or a self-hosted runner supporting Node 24 actions.

## Tests

Run `npm test` with Node 24+. Tests mock Cloudflare/IP responses; no credentials or external requests are needed. The suite covers scoped expressions, validation, foreign-entry preservation, asynchronous operation recovery, partial failures, BFM restoration ordering/failure and actual main/post subprocess state exchange. These tests do not replace a separately authorized live connectivity smoke test.
