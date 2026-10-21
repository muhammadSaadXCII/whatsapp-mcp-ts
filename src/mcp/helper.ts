export const ok = (data: unknown) => ({
    content: [{ type: "text" as const, text: typeof data === "string" ? data : JSON.stringify(data, null, 2) }],
});

export const fail = (msg: string) => ({ isError: true, content: [{ type: "text" as const, text: msg }] });