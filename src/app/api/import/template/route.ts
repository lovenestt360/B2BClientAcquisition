export function GET() {
  const headers = ["First Name", "Last Name", "Email", "Mobile", "Title", "Company", "Website", "Industry", "Country", "City", "LinkedIn"];
  return new Response(`${headers.join(",")}\r\n`, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": 'attachment; filename="contact-import-template.csv"',
      "Cache-Control": "public, max-age=3600",
    },
  });
}
