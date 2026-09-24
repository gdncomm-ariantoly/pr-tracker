// Prints the extension's exact GraphQL request body, for capturing a real fixture:
//   gh api graphql --input <(node tools/print-query.mjs) > /tmp/dashboard.json
import { DASHBOARD_QUERY, SEARCHES } from '../lib/github.js'

process.stdout.write(JSON.stringify({ query: DASHBOARD_QUERY, variables: SEARCHES }))
