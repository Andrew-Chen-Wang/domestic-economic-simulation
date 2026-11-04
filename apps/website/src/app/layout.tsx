import "./globals.css"
import "./dashboard.css"
import type { Metadata } from "next"

export const metadata: Metadata = {
  title: "Domestic Economy Simulator",
  description:
    "An agent-based economy where industries, talent and technology emerge from physical, economic and knowledge constraints.",
}

export default function Layout({ children }: { children: React.ReactNode }) {
  return (
    <html lang={"en"} suppressHydrationWarning>
      <body>{children}</body>
    </html>
  )
}
