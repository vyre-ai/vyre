---
title: Connections and outside services
summary: How a firm's outside services are connected, how to use one, and which operations are outward.
audience: agents
owner: docs
status: stable
tokens: 700
when: You need to read from or act on an outside service such as mail, a calendar, a payment provider or any API, or a tool from an MCP server.
---

# Connections and outside services

An outside service is reached through a connection: a declaration of one https host, how the key is sent, a rate limit and a list of operations. Each operation is marked read, draft, change, send, spend or delete. That mark decides whether it is outward. Only declared operations can be called.

<!-- agent:connections:start -->

Operation kinds: `read`, `draft`, `change`, `send`, `spend`, `delete`.

Connections that ship as declarations, with their operations:
- `stripe`: customers.get (read), customers.list (read), customers.create (change), payment_intents.get (read), payment_intents.list (read), refunds.create (spend).
- `gmail`: profile.get (read), messages.list (read), messages.get (read), threads.get (read), drafts.create (draft), messages.send (send), drafts.send (send).
- `google-calendar`: events.list (read), events.get (read), events.insert (send), events.patch (send), events.delete (delete).

<!-- agent:connections:end -->

## Using one

1. List what is connected: `tools_call connectors.list`. A connection the person did not make or approve is not there to use.
2. Look at its operations: `tools_call connectors.declared` shows them with their marks.
3. Run one: `vault.request` with the connection's credential, a method and a full address on its host (`tools_call connectors.connection.get` shows it as `use`: the credential is `conn-<id>`, not the key item the connection is made from). A view of an app runs an operation with `connectors.operation.run`. Reads and drafts run. An operation marked outward (see the kinds above) is held for a person (read `outward-acts.md`).

You never see or pass the key. The system attaches it outside you when the call is made.

## A service that is not connected

You cannot connect one. Tell the person which service you need and what for. A person can add a connection from a form (host, how the key is sent, operations) or from an API description; only their own surface can do it. In a Flow a connection is used with a `service` step that names the connection and operation.

## MCP servers

Some vendors run their own MCP server. `tools_call mcp.servers` lists the ones the person connected, `tools_call mcp.tools` lists a server's tools, `tools_call mcp.call` runs one. Each server is a sender at the Gate, so anything that leaves goes through approval the same way.

## Mail and calendar

Mail and calendar accounts the person connected are read and drafted freely. Sending mail is outward. A draft is not.

## Inbound

Webhooks from outside arrive through routes the person set up, each checked by the sender's signature. You may be told of an event; you do not open routes.
