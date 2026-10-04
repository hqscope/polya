// Navigation labels shared by the desktop sidebar and the phone-width top bar.
// Pure and dependency-free so `tests/` can import it under Node's test runner.

export interface NavCourse {
  id: string;
  name: string;
  code: string | null;
}

/** The full course label used in the course list: "CS 61B · Data Structures". */
export function courseNavLabel(course: NavCourse): string {
  return course.code ? `${course.code} · ${course.name}` : course.name;
}

/** True when `pathname` is the course's study page or one of its sub-pages.
 * Matches whole path segments, so one id never lights up another. */
export function isCoursePath(pathname: string, courseId: string): boolean {
  const base = `/app/courses/${courseId}`;
  return pathname === base || pathname.startsWith(`${base}/`);
}

/** Short "where am I" label for the phone-width menu button. */
export function currentPlaceLabel(pathname: string, courses: NavCourse[]): string {
  if (pathname === "/app/connect" || pathname.startsWith("/app/connect/")) {
    return "Connect Canvas";
  }
  const course = courses.find((c) => isCoursePath(pathname, c.id));
  if (course) return course.code?.trim() || course.name;
  return "My courses";
}
