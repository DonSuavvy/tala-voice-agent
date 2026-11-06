# Tala

Tala is an AI voice agent that answers tier-1 support calls for a Philippine
internet provider, in English, Tagalog or Taglish, while a human supervisor
watches.

## Calls

**Call**:
One conversation between a caller and Tala, from the opening disclosure to its
disposition.
_Avoid_: contact, interaction

**Caller**:
The person on the line. Not treated as the customer until verification
succeeds.
_Avoid_: user

**Opening disclosure**:
The fixed first line of every call, saying that Tala is an AI assistant and
that the call is recorded.
_Avoid_: greeting, intro

**Caller turn**:
What the caller says before Tala replies, taken as one final transcript.
_Avoid_: message, utterance

**Disposition**:
How a call ended: whether the caller's concern was resolved, what the call was
about, and a short summary for the supervisor.
_Avoid_: wrap-up code, result, outcome (for the whole record)

**Pin**:
The company pack, SOP version, prompt version, policy version and model a call
ran with, recorded so any decision in it can be explained later.
_Avoid_: snapshot, version (alone)

**Fallback line**:
The fixed apology Tala says when a call has to end for any reason other than
the call reaching its disposition.
_Avoid_: error message

## Identity

**Customer**:
A person whose name an account is in. A caller becomes the customer for the
rest of a call once verification succeeds.
_Avoid_: account holder, subscriber

**Verification**:
Proving the caller holds an account, with its account number and the last 4
digits of the mobile number registered on it.
_Avoid_: authentication, login, KYC

**Verified account**:
The one account a call may reach, once verification has succeeded. A call has
at most one.
_Avoid_: customer account, current account

**Account gate**:
The rule that no account tool acts before verification, and afterwards only on
the verified account.
_Avoid_: auth check, permission

**Lock**:
Verification refused for the rest of a call after the policy's limit of failed
attempts.
_Avoid_: lockout, ban

## The company

**Company pack**:
Everything that makes Tala one company's agent: its SOP, policy, persona,
company details and seed world.
_Avoid_: config, tenant, profile

**SOP**:
The versioned standard operating procedure Tala is briefed with. Its figures
come from the policy, never typed into the text.
_Avoid_: script, system prompt (in product talk)

**Policy**:
The limits a company sets that Tala's tools enforce, such as the number of
failed verification attempts allowed.
_Avoid_: rules, settings

**Seed world**:
The demo company's data that every call starts from a fresh copy of: its
accounts, barangays and outages.
_Avoid_: mock data, fixtures, database

**Barangay**:
The smallest administrative district in the Philippines, and the unit outages
are declared against.
_Avoid_: district, neighborhood

**Service area**:
The barangay and city where an account's line is installed.
_Avoid_: address, location

**Outage**:
A network fault affecting one or more barangays, with a cause and, when the
network team has one, an estimated restoration time.
_Avoid_: downtime, incident

**Estimated restoration time**:
When service is expected back after an outage.
_Avoid_: ETA, ETR

## People

**Supervisor**:
The human who watches calls on the console, approves credits above the limit,
and can take a call over.
_Avoid_: agent (ambiguous with Tala), admin
