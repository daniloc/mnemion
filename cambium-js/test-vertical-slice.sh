#!/bin/bash
set -euo pipefail

BASE="http://localhost:8787/mcp"

echo "=== 1. Initialize MCP session ==="
INIT=$(curl -si -X POST "$BASE" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{
    "jsonrpc": "2.0",
    "id": 1,
    "method": "initialize",
    "params": {
      "protocolVersion": "2025-03-26",
      "capabilities": {},
      "clientInfo": { "name": "test", "version": "0.1.0" }
    }
  }')

SESSION_ID=$(echo "$INIT" | grep -i "mcp-session-id:" | tr -d '\r' | awk '{print $2}')
echo "Session: $SESSION_ID"
echo ""

# Send initialized notification
curl -s -X POST "$BASE" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -H "mcp-session-id: $SESSION_ID" \
  -d '{"jsonrpc": "2.0", "method": "notifications/initialized"}' > /dev/null

echo "=== 2. resolve cambium://index (empty) ==="
curl -s -X POST "$BASE" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -H "mcp-session-id: $SESSION_ID" \
  -d '{
    "jsonrpc": "2.0",
    "id": 2,
    "method": "tools/call",
    "params": { "name": "resolve", "arguments": { "uri": "cambium://index" } }
  }' | grep "^data:" | sed 's/^data: //'
echo ""
echo ""

echo "=== 3. propose_change (create tasks object) ==="
PROPOSE=$(curl -s -X POST "$BASE" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -H "mcp-session-id: $SESSION_ID" \
  -d '{
    "jsonrpc": "2.0",
    "id": 3,
    "method": "tools/call",
    "params": {
      "name": "propose_change",
      "arguments": {
        "description": "Create a tasks object for tracking work items",
        "change": {
          "type": "create_object",
          "object_name": "tasks",
          "object_description": "Work items to track and complete",
          "fields": [
            { "name": "title", "type": "text", "required": true },
            { "name": "status", "type": "text", "required": true, "default_value": "active" },
            { "name": "due_date", "type": "datetime" }
          ]
        }
      }
    }
  }')

echo "$PROPOSE" | grep "^data:" | sed 's/^data: //'
CHANGE_ID=$(echo "$PROPOSE" | grep "^data:" | sed 's/^data: //' | node -p "JSON.parse(JSON.parse(require('fs').readFileSync('/dev/stdin','utf8')).result.content[0].text).change_id")
echo ""
echo "Change ID: $CHANGE_ID"
echo ""

echo "=== 4. apply_change ==="
curl -s -X POST "$BASE" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -H "mcp-session-id: $SESSION_ID" \
  -d "{
    \"jsonrpc\": \"2.0\",
    \"id\": 4,
    \"method\": \"tools/call\",
    \"params\": {
      \"name\": \"apply_change\",
      \"arguments\": { \"change_id\": \"$CHANGE_ID\" }
    }
  }" | grep "^data:" | sed 's/^data: //'
echo ""
echo ""

echo "=== 5. mutate (create a task) ==="
curl -s -X POST "$BASE" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -H "mcp-session-id: $SESSION_ID" \
  -d '{
    "jsonrpc": "2.0",
    "id": 5,
    "method": "tools/call",
    "params": {
      "name": "mutate",
      "arguments": {
        "object": "tasks",
        "operation": "create",
        "data": { "title": "Test the vertical slice", "status": "active" }
      }
    }
  }' | grep "^data:" | sed 's/^data: //'
echo ""
echo ""

echo "=== 6. query (read tasks) ==="
curl -s -X POST "$BASE" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -H "mcp-session-id: $SESSION_ID" \
  -d '{
    "jsonrpc": "2.0",
    "id": 6,
    "method": "tools/call",
    "params": {
      "name": "query",
      "arguments": { "object": "tasks" }
    }
  }' | grep "^data:" | sed 's/^data: //'
echo ""
echo ""

echo "=== 7. resolve cambium://index (after evolution) ==="
curl -s -X POST "$BASE" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -H "mcp-session-id: $SESSION_ID" \
  -d '{
    "jsonrpc": "2.0",
    "id": 7,
    "method": "tools/call",
    "params": { "name": "resolve", "arguments": { "uri": "cambium://index" } }
  }' | grep "^data:" | sed 's/^data: //'
echo ""
echo ""

echo "=== Done. The organism grew. ==="
