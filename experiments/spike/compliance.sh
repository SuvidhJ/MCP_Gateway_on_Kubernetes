#!/usr/bin/env bash
# Raw wire checks against the gateway (createMcpHandler behaviour). Usage: spike/compliance.sh [url] [key]
U=${1:-http://127.0.0.1:7801/mcp}; K=${2:-k1}
M='"_meta":{"io.modelcontextprotocol/protocolVersion":"2026-07-28","io.modelcontextprotocol/clientInfo":{"name":"curl","version":"0"},"io.modelcontextprotocol/clientCapabilities":{}}'
req() { local label="$1"; shift; printf '%-44s ' "$label"; curl -s -o /tmp/c.out -w '%{http_code} %{content_type}' "$U" -H "Authorization: Bearer $K" "$@"; printf ' | %s\n' "$(head -c 230 /tmp/c.out | tr '\n' ' ')"; }
J=(-H 'content-type: application/json' -H 'accept: application/json, text/event-stream')
H=(-H 'MCP-Protocol-Version: 2026-07-28')
req "modern discover (ok)"                 "${J[@]}" "${H[@]}" -H 'Mcp-Method: server/discover' -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"server/discover\",\"params\":{$M}}"
req "modern tools/list (ok)"               "${J[@]}" "${H[@]}" -H 'Mcp-Method: tools/list' -d "{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"tools/list\",\"params\":{$M}}"
req "modern, no MCP-Protocol-Version hdr"  "${J[@]}" -H 'Mcp-Method: tools/list' -d "{\"jsonrpc\":\"2.0\",\"id\":3,\"method\":\"tools/list\",\"params\":{$M}}"
req "modern, Mcp-Method mismatch"          "${J[@]}" "${H[@]}" -H 'Mcp-Method: tools/call' -d "{\"jsonrpc\":\"2.0\",\"id\":4,\"method\":\"tools/list\",\"params\":{$M}}"
req "modern tools/call, no Mcp-Name"       "${J[@]}" "${H[@]}" -H 'Mcp-Method: tools/call' -d "{\"jsonrpc\":\"2.0\",\"id\":5,\"method\":\"tools/call\",\"params\":{\"name\":\"demo__echo\",\"arguments\":{\"text\":\"x\"},$M}}"
req "modern tools/call (ok)"               "${J[@]}" "${H[@]}" -H 'Mcp-Method: tools/call' -H 'Mcp-Name: demo__echo' -d "{\"jsonrpc\":\"2.0\",\"id\":6,\"method\":\"tools/call\",\"params\":{\"name\":\"demo__echo\",\"arguments\":{\"text\":\"x\"},$M}}"
req "unsupported version 2027-01-01"       "${J[@]}" -H 'MCP-Protocol-Version: 2027-01-01' -H 'Mcp-Method: tools/list' -d "{\"jsonrpc\":\"2.0\",\"id\":7,\"method\":\"tools/list\",\"params\":{\"_meta\":{\"io.modelcontextprotocol/protocolVersion\":\"2027-01-01\",\"io.modelcontextprotocol/clientInfo\":{\"name\":\"c\",\"version\":\"0\"},\"io.modelcontextprotocol/clientCapabilities\":{}}}}"
req "modern unknown method"                "${J[@]}" "${H[@]}" -H 'Mcp-Method: foo/bar' -d "{\"jsonrpc\":\"2.0\",\"id\":8,\"method\":\"foo/bar\",\"params\":{$M}}"
req "modern ping (removed in 2026)"        "${J[@]}" "${H[@]}" -H 'Mcp-Method: ping' -d "{\"jsonrpc\":\"2.0\",\"id\":9,\"method\":\"ping\",\"params\":{$M}}"
req "modern hdr, no _meta in body"         "${J[@]}" "${H[@]}" -H 'Mcp-Method: tools/list' -d '{"jsonrpc":"2.0","id":10,"method":"tools/list","params":{}}'
req "legacy initialize"                    "${J[@]}" -d '{"jsonrpc":"2.0","id":11,"method":"initialize","params":{"protocolVersion":"2025-11-25","capabilities":{},"clientInfo":{"name":"curl","version":"0"}}}'
req "legacy tools/list (stateless)"        "${J[@]}" -H 'MCP-Protocol-Version: 2025-11-25' -d '{"jsonrpc":"2.0","id":12,"method":"tools/list","params":{}}'
req "legacy ping"                          "${J[@]}" -H 'MCP-Protocol-Version: 2025-11-25' -d '{"jsonrpc":"2.0","id":13,"method":"ping"}'
req "GET (legacy server stream)"           -H 'accept: text/event-stream'
req "DELETE (legacy session end)"          -X DELETE
req "wrong content-type"                   -H 'content-type: text/plain' -d 'x'
req "Origin: https://evil.example"         "${J[@]}" -H 'Origin: https://evil.example' -d '{"jsonrpc":"2.0","id":14,"method":"initialize","params":{"protocolVersion":"2025-11-25","capabilities":{},"clientInfo":{"name":"curl","version":"0"}}}'
req "no Authorization"                     "${J[@]}" -H 'Authorization:' -d '{}'
