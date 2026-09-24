// Prints the extension's exact GraphQL request body, for capturing a real fixture:
//   gh api graphql --input <(node tools/print-query.mjs) > /tmp/dashboard.json
// Watched repos as arguments: node tools/print-query.mjs gdncomm/product-feed
import { DASHBOARD_QUERY, SEARCHES, watchedSearch } from '../lib/github.js'

const watched = process.argv.slice(2)
process.stdout.write(JSON.stringify({ query: DASHBOARD_QUERY, variables: { ...SEARCHES, watched: watchedSearch(watched), hasWatched: watched.length > 0 } }))
