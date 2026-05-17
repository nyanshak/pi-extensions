# ACP Extension Implementation Tasks

> Optional ACP features to extend pi-acp implementation

---

## Priority 1: Core UX Features

### Task 1: Implement `session/cancel` - Cancel ongoing prompts

**Priority:** P0 (Critical)  
**Spec Section:** prompt-turn  
**Spec Text:** "Clients MAY cancel an ongoing prompt turn at any time by sending a `session/cancel` notification"

**Description:**
Handle the `session/cancel` notification from the client. When received:
1. Cancel any ongoing language model requests
2. Cancel any in-progress tool executions
3. Mark all non-finished tool calls as `cancelled`
4. Send any final tool call updates before responding
5. Return the `session/prompt` response with `stopReason: "cancelled"` or similar

**Implementation Notes:**
- Add `case "session/cancel"` handler
- Track active tool executions to cancel them
- Emit cancellation events for tools

**Tests:**
- Send `session/cancel` during tool execution, verify tool status becomes `cancelled`
- Send `session/cancel`, verify `session/prompt` response indicates cancellation
- Verify tool call updates still arrive after cancel (per spec: "SHOULD still accept tool call updates")

---

### Task 2: Implement `available_commands_update` - Slash commands

**Priority:** P0 (Critical)  
**Spec Section:** slash-commands  
**Spec Text:** "After creating a session, the Agent MAY send a list of available commands via the `available_commands_update` session notification"

**Description:**
Send the list of available slash commands to the client after session creation. Commands should include:
- `name` - command name (e.g., "plan", "test", "web")
- `description` - human-readable description
- `input.hint` - hint for expected input (optional)

**Implementation Notes:**
- Define list of available commands in the extension
- Send `session/update` with `sessionUpdate: "available_commands_update"` after `session/new`
- Commands should be useful for the coding agent context

**Tests:**
- After `session/new`, verify `available_commands_update` notification is received
- Verify command list contains expected commands (e.g., "plan", "test")
- Verify command structure has required fields (name, description)

---

## Priority 2: Better Agent UX

### Task 3: Implement `session/request_permission` - Tool permissions

**Priority:** P1 (High)  
**Spec Section:** tool-calls  
**Spec Section:** initialization  
**Spec Text:** "The Agent MAY request permission from the user before executing a tool call by calling the `session/request_permission` method"

**Description:**
Request permission from the client before executing sensitive tool operations. Send permission request with options:
- `allow-once` - Allow this once
- `reject-once` - Reject this once
- `allow-always` - Always allow (if supported)
- `reject-always` - Always reject (if supported)

Handle the response from the client and proceed or reject accordingly.

**Implementation Notes:**
- Define which tools need permission (e.g., destructive operations)
- Send `session/request_permission` request with tool details
- Await response and proceed based on outcome
- Track permission state for "always" options

**Tests:**
- Trigger a permission-requiring tool, verify `session/request_permission` is sent
- Accept permission, verify tool executes
- Reject permission, verify tool does not execute
- Handle cancelled permission request

---

### Task 4: Implement `plan` notifications - Execution plan tracking

**Priority:** P1 (High)  
**Spec Section:** agent-plan  
**Spec Text:** "When the language model creates an execution plan, the Agent SHOULD report it to the Client"

**Description:**
Report the agent's execution plan to the client as it works. Each plan entry includes:
- `content` - Description of the task
- `priority` - "high", "medium", or "low"
- `status` - "pending", "in_progress", "completed", or "failed"

Send initial plan after session creation (if agent generates one), then update as progress is made.

**Implementation Notes:**
- Listen for internal plan events from the agent
- Send `session/update` with `sessionUpdate: "plan"` and `entries` array
- Update entries as tasks complete/fail

**Tests:**
- Verify `plan` notification is sent with valid structure
- Verify plan entries have required fields (content, priority, status)
- Verify status updates are sent as tasks complete

---

### Task 5: Implement `session/list` - List existing sessions

**Priority:** P1 (High)  
**Spec Section:** session-list  
**Spec Text:** "Clients discover existing sessions by calling the `session/list` method with optional filtering and pagination parameters"

**Description:**
Implement the `session/list` method to list existing sessions with:
- Optional `cursor` for pagination
- Optional `pageSize` limit
- Response includes `sessions` array and `nextCursor` if more available

**Implementation Notes:**
- Add `case "session/list"` handler
- Maintain list of sessions internally
- Support cursor-based pagination
- Return session metadata (id, name, last active, etc.)

**Tests:**
- Call `session/list`, verify it returns sessions array
- Create multiple sessions, verify all appear in list
- Test pagination with `pageSize` parameter
- Test cursor-based pagination

---

## Priority 3: Advanced Features

### Task 6: Implement `session/set_context_variables` - Context variables

**Priority:** P2 (Medium)  
**Spec Section:** session-config-options  
**Spec Text:** "Each config option MAY include a `category` field"

**Description:**
Allow the client to set context variables that the agent can access. These are key-value pairs that persist for the session. Variables can be:
- User preferences
- Project context
- Custom data

**Implementation Notes:**
- Add storage for context variables
- Add `session/set_context_variables` handler
- Pass variables to agent when prompting

**Tests:**
- Set context variables, verify they persist
- Clear context variables
- Verify context variables are accessible during prompt

---

### Task 7: Implement `session/update_metadata` - Session metadata

**Priority:** P2 (Medium)  
**Spec Section:** session-setup  
**Spec Text:** "All fields are optional. Only include fields that have changed — omitted fields are left unchanged."

**Description:**
Track and update metadata for sessions:
- `name` - Session name
- `description` - Session description
- `lastActive` - Last activity timestamp

**Implementation Notes:**
- Add metadata storage per session
- Add `session/update_metadata` handler
- Send metadata updates when they change

**Tests:**
- Update session name, verify it persists
- Update description
- Verify updates don't affect other metadata fields

---

### Task 8: Implement `terminal` notifications - Live terminal output

**Priority:** P2 (Medium)  
**Spec Section:** terminals  
**Spec Text:** "If the terminal was added to a tool call, the client SHOULD continue to display its output after release."

**Description:**
Report terminal created during tool execution for live output streaming. Include:
- `terminalId` - Unique terminal identifier
- `title` - Terminal title
- Location information for terminal positioning

**Implementation Notes:**
- Track terminal IDs for spawned processes
- Send `terminal` notification when terminal is created
- Send terminal close notification when done

**Tests:**
- Run bash command, verify `terminal` notification is received
- Verify terminal has required fields (terminalId, title)
- Verify terminal is closed after tool completes

---

### Task 9: Enhance `authenticate` - Real auth flow

**Priority:** P2 (Medium)  
**Spec Section:** initialization  
**Spec Text:** "The authenticate method allows clients to complete authentication flows"

**Description:**
Implement a real authentication flow instead of the current no-op. This could be:
- Token-based authentication
- OAuth flow (if supported by host)
- Simple password/credential handling

**Implementation Notes:**
- Define auth methods supported in `initialize` response
- Implement `authenticate` method with proper validation
- Store auth state per session

**Tests:**
- Call `authenticate` with invalid credentials, verify error
- Call `authenticate` with valid credentials, verify success
- Verify auth state persists for session

---

### Task 10: Client permission response handling

**Priority:** P2 (Medium)  
**Spec Section:** tool-calls  
**Spec Text:** "Clients MAY automatically allow or reject permission requests according to the user settings"

**Description:**
Handle permission responses from client for `session/request_permission`:
- Handle `allow-once` responses
- Handle `reject-once` responses
- Handle `allow-always` (if client supports)
- Handle `reject-always` (if client supports)
- Handle `cancelled` outcome

**Implementation Notes:**
- This is the counterpart to Task 3
- Track always-allow/always-reject rules
- Apply stored rules automatically

**Tests:**
- Send permission request, client allows once, verify tool runs
- Send permission request, client rejects once, verify tool skipped
- Test always-allow/always-reject persistence

---

## Priority 4: Edge Cases & Extensibility

### Task 11: Implement `_meta` trace context - OpenTelemetry

**Priority:** P3 (Low)  
**Spec Section:** extensibility  
**Spec Text:** "The following root-level keys in `_meta` SHOULD be reserved for W3C trace context to guarantee interop"

**Description:**
Support W3C trace context in `_meta` field:
- `traceparent` - Trace identification
- `tracestate` - Trace state

**Implementation Notes:**
- Extract `_meta.traceparent` from requests
- Propagate trace context in responses
- Use for debugging/logging correlation

**Tests:**
- Send request with `traceparent`, verify it's echoed back
- Verify trace context flows through session

---

### Task 12: Custom capability advertising

**Priority:** P3 (Low)  
**Spec Section:** extensibility  
**Spec Text:** "Implementations SHOULD use the `_meta` field in capability objects to advertise support for extensions"

**Description:**
Advertise custom capabilities via `_meta` field in capabilities:
- Signal support for custom methods
- Allow clients to adapt behavior based on capabilities

**Implementation Notes:**
- Add `_meta` field to `agentCapabilities`
- Define custom extension capabilities

**Tests:**
- Verify `_meta` appears in `initialize` response
- Verify custom capabilities are advertised

---

### Task 13: HTTP transport support for MCP

**Priority:** P3 (Low)  
**Spec Section:** session-setup  
**Spec Text:** "While they are not required to by the spec, new Agents SHOULD support the HTTP transport"

**Description:**
Add HTTP transport support for MCP servers (beyond stdio):
- Accept HTTP connection parameters
- Support SSE for server-sent events

**Implementation Notes:**
- This requires significant architecture changes
- May need additional HTTP server setup

**Tests:**
- Start MCP server over HTTP, verify connection works
- Test bidirectional communication

---

### Task 14: Full `session/resume` - Complete state restoration

**Priority:** P3 (Low)  
**Spec Section:** session-setup  
**Spec Text:** "Agents MAY return an error if the session does not exist or is not currently active"

**Description:**
Implement full session resumption including:
- Complete conversation history restoration
- Tool call history
- Session metadata and context

**Implementation Notes:**
- Serialize full session state on save
- Restore all state on resume
- Handle missing/invalid sessions gracefully

**Tests:**
- Save session with history, resume, verify full state restored
- Resume session with missing ID, verify error
- Verify tool history is preserved

---

## Testing Guidelines

Each task MUST include:

1. **Unit Tests** - Test the handler/implementation directly
2. **Integration Tests** - Test via ACP protocol (spawn agent, send requests)
3. **Edge Case Tests** - Error conditions, invalid input, timeout handling

**Test Pattern for ACP Integration:**
```typescript
// Spawn fresh agent for each test
const agent = spawn("pi", ["--acp"], { stdio: ["pipe", "pipe", "pipe"] });
// Send JSON-RPC requests
// Parse responses
// Verify expected notifications and results
// Clean up with agent.kill()
```

---

## Metadata

Created: 2026-05-16  
Project: pi-acp  
Status: Backlog