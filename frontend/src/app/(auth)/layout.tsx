// The public auth pages (login/register/forgot-password/reset-password) had
// no `<main>` landmark at all — each page renders straight under the root
// layout's `<body>`. Found via a real Lighthouse accessibility audit
// ("Document does not have a main landmark") on every one of them. One
// shared layout fixes all four at once rather than editing each page.
export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return <main>{children}</main>;
}
