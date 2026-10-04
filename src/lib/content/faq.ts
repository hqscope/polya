// The landing FAQ. One array drives both the visible section on `/` and the
// FAQPage JSON-LD in structured-data.ts, so the two can never drift apart.
// Questions are phrased the way students actually search.

import { orgName } from "@/lib/seo";

export interface FaqItem {
  question: string;
  answer: string;
}

export const FAQ_ITEMS: FaqItem[] = [
  {
    question: "What is Polya?",
    answer:
      "Polya is an AI tutor that works from your actual course. Connect a class and Polya reads the readings, slides, and lecture recordings, then helps the way a good tutor would — hints and steps first, with every answer citing exactly where in the course it came from.",
  },
  {
    question: "Does Polya work with my school’s Canvas?",
    answer:
      "Yes. Polya connects to the Canvas account you already use at your school and brings in the materials for the courses you choose. You pick which courses Polya can see, and nothing is ever posted back to Canvas.",
  },
  {
    question: "Will Polya just give me the answer?",
    answer:
      "Not by default. Ask “solve this” and Polya starts with a hint, then a step, then a worked example — the full solution comes when that’s what actually helps you learn. You stay in control of how far up the ladder you go.",
  },
  {
    question: "Is using Polya cheating?",
    answer:
      "Polya is built for learning, not shortcuts. It teaches through problems instead of finishing them, shows the source behind every claim so you can verify it, and follows the assistance policy your instructor sets for the course. What counts as permitted help is always your instructor’s call — check your syllabus.",
  },
  {
    question: "Where do Polya’s answers come from?",
    answer:
      "From your course. Every claim carries a citation that opens the exact PDF page, slide, or lecture moment behind it — so you can check the source yourself in one click.",
  },
  {
    question: "Can my instructor control how much help Polya gives?",
    answer:
      "Yes. Instructors choose a per-course assistance policy — Open, Guided, Practice, or Review — and Polya visibly follows it. Students see the active policy in every conversation.",
  },
  {
    question: "Is Polya free?",
    answer:
      "Polya is free to start. Sign in with Google, connect your school’s Canvas, and study with your courses.",
  },
  {
    question: "Who made Polya?",
    answer:
      `Polya is built by ${orgName} and named for George Pólya, the mathematician whose book How to Solve It taught generations how to work through problems step by step.`,
  },
];
