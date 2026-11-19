import { test, expect } from "@playwright/test";

// F0's e2e scaffold — deliberately small and backend-independent, so it
// runs the same in CI (no seeded DB/running backend) as it does locally.
// This covers pure client-side routing/rendering behavior only; it is NOT
// a substitute for this session's own live-backend verification pass
// (every feature in docs/plans/FRONTEND_PLAN.md was hand-verified against
// a real running backend + MongoDB, which is a different kind of
// correctness than "does the login page render").

test.describe("unauthenticated routing", () => {
  test("visiting /app with no session redirects to /login", async ({ page }) => {
    await page.goto("/app");
    await expect(page).toHaveURL(/\/login$/);
  });

  test("visiting a deep chat link with no session also redirects to /login", async ({ page }) => {
    await page.goto("/app/c/000000000000000000000000");
    await expect(page).toHaveURL(/\/login$/);
  });
});

test.describe("login page", () => {
  test("renders the email sign-in form by default", async ({ page }) => {
    await page.goto("/login");
    await expect(page.getByPlaceholder("you@example.com")).toBeVisible();
    await expect(page.getByRole("button", { name: "Sign in" })).toBeVisible();
    await expect(page.getByRole("link", { name: "Create an account" })).toBeVisible();
  });

  test("switching to the Phone option swaps the email field for a phone field", async ({ page }) => {
    await page.goto("/login");
    await page.getByRole("radio", { name: "Phone" }).click();
    await expect(page.getByPlaceholder("you@example.com")).toBeHidden();
  });
});
