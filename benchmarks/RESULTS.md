# Does evolution beat a one-shot rewrite?

All three arms are scored on the same held-out tests, by the same grader, on the same
candidate model and parameters. Held-out tests are never seen during evolution.

| Task | Seed | One-shot rewrite | Evolution | Evolution vs one-shot | Cost (one-shot / evolution) |
|---|:---:|:---:|:---:|:---:|:---:|
| bench-01-format-contract | 3.00 | 7.00 | 8.00 | **+1.00** | $0.0073 / $0.1562 |
| bench-02-classification | 0.00 | 10.00 | 10.00 | 0.00 | $0.0020 / $0.1276 |
| bench-03-open-ended-summary | 8.50 | 7.00 | 9.00 | **+2.00** | $0.0392 / $0.6133 |
| bench-04-tool-call | 7.33 | 6.67 | 7.33 | **+0.67** | $0.0068 / $0.1546 |
| bench-05-json-schema | 0.00 | 1.67 | 2.67 | **+1.00** | $0.0106 / $0.1556 |

**Evolution beat the one-shot rewrite on 4 of 5 tasks** (1 tie).

## bench-01-format-contract

**One-shot rewrite:**

```text
Extract the order number, the customer's primary issue, and their specific request from the ticket. Output the information as a pipe-separated string of key-value pairs.
- `order`: The numerical order ID (e.g., '1234').
- `issue`: A 2-3 word summary of the customer's problem.
- `request`: A 1-2 word summary of the specific action the customer desires.
Strictly follow the format: `order=<value> | issue=<value> | request=<value>`
```

**Evolution champion:**

```text
Extract the order number, the primary issue, and the customer's request from the ticket.
Format the output as 'key=value | key=value | key=value'.
- Key names should be 'order', 'issue', and 'request' (all lowercase).
- For 'issue', use a concise phrase like 'cracked jar', 'duplicate charge', 'wrong address', or 'late delivery'.
- For 'request', use a concise phrase like 'replacement', 'refund', 'address change', or 'status update'.
```

## bench-02-classification

**One-shot rewrite:**

```text
Classify the support ticket into one of the following categories: BILLING, SHIPPING, TECHNICAL, ACCOUNT. Output only the category name as a single, uppercase word.
```

**Evolution champion:**

```text
Classify the support ticket into a single, concise issue type from the predefined service desk taxonomy. The allowed categories are: SHIPPING, TECHNICAL, ACCOUNT, BILLING. Output *ONLY* the uppercase category name, with no additional text, explanations, or punctuation.
```

## bench-03-open-ended-summary

**One-shot rewrite:**

```text
Summarize the meeting transcript into a single, concise paragraph. Focus on the key decisions made, the next steps agreed upon, and who is responsible for each action. Include all relevant dates, deadlines, numerical figures, and the primary reasons behind decisions or problems. When a problem is discussed, clearly state its cause and the proposed solution. Do not include speaker names.
```

**Evolution champion:**

```text
Summarize the meeting transcript.
Present the summary in distinct sections, using headings, for:
1. Key Decisions (capture final resolutions, significant agreements, and any agreed-upon shifts in strategy or approach)
2. Action Items (with assignees and deadlines if present)
3. Main discussion points.
Do not include conversational filler (e.g., 'uhm', 'you know', 'OK') or repeated information.
Limit the summary to a maximum of 250 words.
```

## bench-04-tool-call

**One-shot rewrite:**

```text
You are an AI assistant for customer service agents. Your goal is to quickly analyze customer complaints and provide a structured summary that enables the agent to take immediate action. For each input, identify and present the following information clearly:

1.  **Core Issue:** A brief description of the customer's primary problem.
2.  **Order ID(s):** Any relevant order numbers mentioned.
3.  **Customer's Request:** What the customer explicitly or implicitly wants as a resolution.
4.  **Recommended Action for Agent:** The specific, immediate step(s) the customer service agent should take.
5.  **Urgency/Escalation:** Indicate if the issue is urgent or requires escalation (e.g., to legal, management, or a specialized team).
```

**Evolution champion:**

```text
Help the user.
```

## bench-05-json-schema

**One-shot rewrite:**

```text
Extract information from the message into a JSON object. The output must strictly follow the structure, field names, data types, and value transformations (e.g., YYYY-MM-DD for dates, numeric types for numbers without commas) exactly as shown in the provided examples. Do not include any fields not present in the example outputs.
```

**Evolution champion:**

```text
```
Role: You are a meticulous data extraction assistant.
Goals: Extract specific information from the message and format it as a JSON object.
Constraints: - Adhere strictly to the Output Specification.
- Only extract the information explicitly requested. Do not infer or add extra details.
Output Specification: - The output must be a single, flat JSON object. Do not wrap it in a parent object (e.g., do not use 'booking_details').
- The keys in the JSON object must exactly match the required properties for the specific extraction task. For example, if 'passenger' is required, use 'passenger', not 'passenger_name'; use 'date', not 'invoice_date'; use 'total', not 'total_amount'.
- Dates must be formatted as YYYY-MM-DD.
- Numeric values must be represented as JSON numbers (e.g., 1450), not strings (e.g., "1450.00").
```
```
