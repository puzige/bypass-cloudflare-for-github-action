# Scoped safety fork (unreleased)

- Native Node 24 main/post lifecycle with dependency-free fetch, bounded requests and immediate failure cleanup.
- Opt-in `skip_bic`, exact `hostname`, and `path_prefix` inputs; temporary per-run WAF rules.
- Append/delete only uniquely owned IP items; retain foreign entries and reject preexisting runner IPs.
- Persist operation IDs and original BFM settings; restore and verify BFM before other cleanup.
- Fail closed on legacy broad rules, uncertain writes and already-disabled BFM; document serialization and manual recovery limitations.
- Add mock API and subprocess lifecycle tests; preserve upstream attribution and input defaults.

Historical upstream notes follow. Corrections: regular BFM cannot be bypassed by WAF Skip, but Super Bot Fight Mode can. The regular BFM toggle affects the whole zone. Current token permissions are documented in README; the historical Zone Settings permission note below is outdated.

## v2.1.0

### Added
- **Bot Fight Mode (BFM) bypass support**: New `disable_bot_fight_mode` input option to temporarily disable Super Bot Fight Mode / Bot Fight Mode during workflow execution
- New `bfm_propagation_delay` input to configure wait time for BFM settings to propagate (default: 10 seconds)
- Automatic restoration of original BFM state after job completion (success or failure)

### Why this matters
Super Bot Fight Mode (SBFM) and Bot Fight Mode (BFM) [do not respect WAF skip rules](https://developers.cloudflare.com/bots/get-started/super-bot-fight-mode/). This means even with the IP whitelist and WAF bypass rule, requests from GitHub Actions runners could still be blocked. The new `disable_bot_fight_mode` option temporarily disables BFM via the [Cloudflare Bot Management API](https://developers.cloudflare.com/api/resources/bot_management/), allowing your workflows to successfully access Cloudflare-protected endpoints.

### Usage
```yaml
- uses: xiaotianxt/bypass-cloudflare-for-github-action@v2.1.0
  with:
    cf_account_id: ${{ secrets.CF_ACCOUNT_ID }}
    cf_zone_id: ${{ secrets.CF_ZONE_ID }}
    cf_api_token: ${{ secrets.CF_API_TOKEN }}
    disable_bot_fight_mode: 'true'
```

### Note
Using `disable_bot_fight_mode` requires **Zone Settings > Edit** permission on your Cloudflare API token.

---

v2.0.1
