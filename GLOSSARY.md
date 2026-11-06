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

**Line**:
What Tala says in one go: the opening disclosure, one reply, or the fallback
line.
_Avoid_: utterance, message, response

**Caller turn**:
What the caller says before Tala replies, taken as one final transcript.
_Avoid_: message, utterance

**Interruption**:
The caller cutting in while Tala is still saying a line. She stops, and the
call remembers only the part of the line the caller heard.
_Avoid_: abort, cancellation

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

**Filler line**:
The fixed short line Tala says when she starts a check without having said
anything, so the caller is never left in silence.
_Avoid_: hold message, placeholder

**Closing line**:
The fixed goodbye Tala says when a call reaches its disposition without one.
_Avoid_: sign-off, outro

## Identity

**Customer**:
A person whose name an account is in. A caller becomes the customer for the
rest of a call once verification succeeds.
_Avoid_: account holder, subscriber

**Verification**:
Proving the caller holds an account, with its account number and the last 4
digits of the mobile number registered on it.
_Avoid_: authentication, login, KYC

**Registered mobile**:
The mobile number on file for an account: the one verification checks, and the
only one Tala sends texts to.
_Avoid_: contact number, phone number (alone)

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
company details, plans, help articles and seed world.
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
accounts, barangays, outages, balances, bills, payments, modems and slots.
_Avoid_: mock data, fixtures, database

**Barangay**:
The smallest administrative district in the Philippines, and the unit outages
are declared against.
_Avoid_: district, neighborhood

**Service area**:
The barangay and city where an account's line is installed.
_Avoid_: address, location

**Outage**:
A network failure affecting a whole area of one or more barangays, with a
cause and, when the network team has one, an estimated restoration time.
_Avoid_: downtime, incident

**Estimated restoration time**:
When service is expected back after an outage.
_Avoid_: ETA, ETR

## Connections

**Modem**:
The device at the customer's home that their fiber connection ends in, which
the network can see and restart.
_Avoid_: router, ONU, ONT

**Diagnosis**:
What the network's own monitoring says about the connection at an account's
home: the modem's status and signal, when it was last seen, any fault, and
whether a remote reboot may clear it.
_Avoid_: line test, line check

**Fault**:
A problem a diagnosis finds on one account's connection, described in plain
words.
_Avoid_: error, issue

**Remote reboot**:
A restart of an account's modem from the network side, followed by a fresh
diagnosis once the modem is back.
_Avoid_: reset, power cycle

## Billing

**Bill**:
The statement of what an account owes for one month of service.
_Avoid_: invoice, statement of account

**Balance**:
What an account owes now, and the date it is due.
_Avoid_: dues, outstanding

**Payment**:
Money a customer has paid towards an account's balance, through a payment
channel.
_Avoid_: transaction, remittance

**Payment channel**:
The service a payment was made through: GCash, Maya, a bank, 7-Eleven or
Bayad.
_Avoid_: payment method, payment provider

**Payment reference**:
The number a payment channel gives the customer for one payment, by which the
payment is found.
_Avoid_: transaction ID, receipt number, ref number

**Posted**:
Said of a payment the billing system has applied to the balance. A payment can
be received and not yet posted.
_Avoid_: reflected, credited, cleared

**Disconnection**:
Service cut off for an unpaid balance, on a scheduled date after the balance
was due.
_Avoid_: cut-off, termination

**Billing cycle**:
The month of service that starts when an account's latest bill is issued and
ends at the same time one calendar month later.
_Avoid_: billing period, statement period

## Plans

**Plan**:
One of the internet services a company offers, with a download speed and a
monthly price. Every account is on one; together they are the plan catalog.
_Avoid_: package, subscription, product

**Upgrade**:
A change to a plan with a higher monthly price. It starts at once, with a
prorated amount.
_Avoid_: upsell

**Downgrade**:
A change to a plan that costs no more a month. It starts with the next billing
cycle, with no prorated amount.
_Avoid_: plan reduction

**Prorated amount**:
What an upgrade adds to the next bill: the difference in monthly price for the
part of the billing cycle still to run.
_Avoid_: pro-rata charge, adjustment

**Quote**:
The price of one plan change for the verified account: the new monthly price,
any prorated amount and when the change takes effect, with a reference. A plan
changes only with a quote made on the call, once, after the caller says yes.
_Avoid_: estimate, offer, quotation

## Help

**Help article**:
A short public answer to a general how-to question, such as what a light on
the modem means. Reading one out needs no verification.
_Avoid_: FAQ, doc, knowledge article

**Knowledge base**:
All of a company's help articles.
_Avoid_: help center, FAQ

## Tickets

**Ticket**:
A request, opened on the verified account, for a team to do what Tala cannot do
on the call, with a reference the caller can quote back.
_Avoid_: case, complaint, trouble report

**Technician visit**:
A technician coming to the customer's home in a slot the caller picked, booked
against a ticket opened on the call, with a reference the caller can quote
back.
_Avoid_: appointment, dispatch, site visit

**Slot**:
A window of hours on one day in which a technician can visit a barangay. Tala
offers slots by their windows, and a booked slot holds one technician visit.
_Avoid_: appointment, time slot, schedule

## People

**Supervisor**:
The human who watches calls on the console, approves credits above the limit,
and can take a call over.
_Avoid_: agent (ambiguous with Tala), admin
