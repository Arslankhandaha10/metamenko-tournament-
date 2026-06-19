/**
 * Server-side NFT ownership verification.
 *
 * Issues a GraphQL query to the Movement Indexer to confirm the wallet owns
 * the claimed NFT. No SDK dependency — portable across Cloud Functions,
 * GitHub Actions, or any Node host.
 *
 * Strategy:
 *   1. Query current_token_ownerships_v2 for the wallet (amount > 0).
 *   2. Match by token_name === claimedNftName (case-insensitive).
 *   3. Optionally constrain by collection_id if cfg.nftCollectionId is set.
 *
 * Returns { owned: boolean, reason: string, raw: object|null }.
 *
 * TRANSIENT vs PERMANENT failures:
 *   THROWS on transient failures (network errors, 5xx, parse errors) so the
 *   caller (claims.js) leaves the claim pending_verify for retry.
 *   Only "queried successfully and wallet does NOT own the NFT" returns
 *   { owned: false, reason: "not_in_wallet" } — the only permanent rejection.
 */
const NFT_QUERY = `
  query getAccountNFTs($where_condition: current_token_ownerships_v2_bool_exp!, $offset: Int, $limit: Int) {
    current_token_ownerships_v2(where: $where_condition, offset: $offset, limit: $limit) {
      token_data_id
      owner_address
      amount
      current_token_data {
        token_name
        collection_id
        current_collection { collection_id collection_name }
        token_standard
      }
    }
  }`;

function normalizeAddress(addr) {
  if (!addr) return '';
  const a = String(addr).trim();
  return a.startsWith('0x') ? '0x' + a.slice(2).toLowerCase() : a.toLowerCase();
}

/**
 * @param {{ walletAddress: string, claimedNftName: string }} input
 * @param {{ indexerGraphqlUrl: string, nftCollectionId?: string }} cfg
 * @returns {Promise<{ owned: boolean, reason: string, raw: any }>}
 */
async function verifyOwnership(input, cfg) {
  const wallet = normalizeAddress(input && input.walletAddress);
  const wanted = String((input && input.claimedNftName) || '').trim();

  if (!wallet) return { owned: false, reason: 'no_wallet', raw: null };
  if (!wanted) return { owned: false, reason: 'no_nft_name', raw: null };

  const url = (cfg && cfg.indexerGraphqlUrl) || 'https://indexer.mainnet.movementnetwork.xyz/v1/graphql';

  const where = { owner_address: { _eq: wallet }, amount: { _gt: 0 } };
  if (cfg && cfg.nftCollectionId) {
    where.current_token_data = { collection_id: { _eq: String(cfg.nftCollectionId) } };
  }

  let raw = null;
  let resp;
  try {
    const fetcher = (typeof fetch !== 'undefined') ? fetch : require('node-fetch');
    resp = await fetcher(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        query: NFT_QUERY,
        variables: { where_condition: where, offset: 0, limit: 500 }
      })
    });
  } catch (e) {
    throw new Error('indexer_fetch_failed:' + ((e && e.message) || String(e)));
  }

  if (!resp.ok) {
    throw new Error(`indexer_http_${resp.status}`);
  }

  try {
    raw = await resp.json();
  } catch (e) {
    throw new Error('indexer_parse_failed:' + ((e && e.message) || String(e)));
  }

  if (raw && Array.isArray(raw.errors) && raw.errors.length > 0) {
    throw new Error('indexer_graphql_error:' + (raw.errors[0].message || ''));
  }

  const rows = (raw && raw.data && raw.data.current_token_ownerships_v2) || [];
  const wantedLower = wanted.toLowerCase();
  for (let i = 0; i < rows.length; i++) {
    const td = rows[i] && rows[i].current_token_data;
    if (!td || !td.token_name) continue;
    if (String(td.token_name).toLowerCase() === wantedLower) {
      return { owned: true, reason: 'verified', raw };
    }
  }
  return { owned: false, reason: 'not_in_wallet', raw };
}

module.exports = { verifyOwnership, normalizeAddress };
