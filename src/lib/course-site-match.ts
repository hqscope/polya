// Which of the student's courses a pasted course-website address most likely
// belongs to, so "Add a course → course website" can preselect it instead of
// creating a duplicate. Pure and dependency-free so `tests/` can import it.

export interface SiteCourseOption {
  id: string;
  name: string;
  code: string | null;
}

// A course number with an optional letter suffix: "DATA C100" → "100",
// "CS 61B" → "61b", "MCELLBI 102" → "102".
function courseNumber(course: SiteCourseOption): string | null {
  const match = `${course.code ?? ""} ${course.name}`.toLowerCase().match(/[a-z]?(\d{2,3}[a-z]{0,2})\b/);
  return match ? match[1]! : null;
}

/**
 * The id of the one course whose number appears in the address
 * ("ds100.org/fa26" → DATA C100, "cs61b.org" → CS 61B), or null when none or
 * several do. Term codes ("fa26") aren't course numbers: a number must not
 * follow another digit or a term prefix.
 */
export function suggestCourseForSite(address: string, courses: SiteCourseOption[]): string | null {
  const text = address.toLowerCase().replace(/^https?:\/\//, "");
  if (!text.trim()) return null;
  const matches = courses.filter((course) => {
    const number = courseNumber(course);
    if (!number) return false;
    const escaped = number.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`(^|[^0-9])(?<!fa|sp|su|wi)${escaped}(?![0-9])`).test(text);
  });
  return matches.length === 1 ? matches[0]!.id : null;
}
