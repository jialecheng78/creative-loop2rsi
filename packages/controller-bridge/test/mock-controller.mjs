const mode = process.argv[2];
const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const request = JSON.parse(Buffer.concat(chunks).toString("utf8"));
const envelope = {
  protocol_version: request.protocol_version,
  request_id: request.request_id,
  operation: request.operation,
};

switch (mode) {
  case "echo":
    process.stderr.write("diagnostic output is intentionally not returned\n");
    process.stdout.write(
      JSON.stringify({
        ...envelope,
        status: "PASS",
        received: request,
        inheritedCredentialEnvironment: Object.keys(process.env).some((name) =>
          /(?:key|password|secret|token)/i.test(name),
        ),
      }),
    );
    break;
  case "block":
    process.stdout.write(
      JSON.stringify({ ...envelope, status: "BLOCK", error: { code: "SyntheticBlock", message: "blocked" } }),
    );
    process.exitCode = 2;
    break;
  case "mismatch":
    process.stdout.write(JSON.stringify({ ...envelope, request_id: "wrong-id", status: "PASS" }));
    break;
  case "double-json":
    process.stdout.write(`${JSON.stringify({ ...envelope, status: "PASS" })}\n`);
    process.stdout.write(`${JSON.stringify({ ...envelope, status: "PASS" })}\n`);
    break;
  case "large":
    process.stdout.write(JSON.stringify({ ...envelope, status: "PASS", value: "x".repeat(4096) }));
    break;
  case "sleep":
    setTimeout(() => process.stdout.write(JSON.stringify({ ...envelope, status: "PASS" })), 5_000);
    break;
  default:
    process.stdout.write(
      JSON.stringify({ ...envelope, status: "BLOCK", error: { code: "UnknownMockMode", message: "blocked" } }),
    );
    process.exitCode = 2;
}
