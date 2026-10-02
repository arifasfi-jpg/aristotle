import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Hippoturtle — Build your company without building a huge team',
  description: 'Think of an idea. Test it with evidence. Turn it into a plan. Get the work done with AI, humans, or both.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return <html lang="en"><head>
    <link rel="preconnect" href="https://fonts.googleapis.com" /><link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="" />
    {/* eslint-disable-next-line @next/next/no-page-custom-font */}
    <link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700;800&display=swap" rel="stylesheet" />
  </head><body>{children}</body></html>;
}
