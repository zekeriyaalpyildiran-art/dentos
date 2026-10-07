# 🤝 Contributing to DentOS

Welcome! This guide explains how to contribute to the DentOS dental clinic management system.

---

## 🎯 Mission

DentOS is a comprehensive dental clinic management system designed specifically for Turkish healthcare providers. We welcome contributions that improve:

- **Features** - New capabilities and modules
- **Performance** - Speed and efficiency improvements
- **Security** - Better protection for patient data
- **Usability** - Improved UX/UI
- **Documentation** - Clearer guides and examples
- **Testing** - Better test coverage
- **Accessibility** - WCAG compliance

---

## 🚀 Getting Started

### 1. Fork and Clone

```bash
# Fork the repository on GitHub
# Then clone your fork
git clone https://github.com/YOUR-USERNAME/dentos.git
cd dentos

# Add upstream remote
git remote add upstream https://github.com/zekeriyaalpyildiran-art/dentos.git
```

### 2. Setup Development Environment

```bash
# Install dependencies
pnpm install

# Setup environment variables
cp .env.example .env.local
# Edit .env.local with your database details

# Start database
docker-compose up -d postgres

# Run migrations
pnpm drizzle-kit migrate:pg

# Seed test data
curl -X POST http://localhost:3000/api/seed

# Start development server
pnpm dev
```

### 3. Create a Branch

```bash
# Update main
git checkout main
git pull upstream main

# Create feature branch
git checkout -b feat/your-feature-name

# Or for bug fixes:
git checkout -b fix/bug-description

# Or for documentation:
git checkout -b docs/documentation-topic
```

---

## 📝 Development Standards

### Code Style

**TypeScript:**
```typescript
// ✅ Good
export function calculateTotalCost(items: TreatmentItem[]): number {
  return items.reduce((sum, item) => sum + item.cost, 0);
}

// ❌ Bad
export function calculateTotalCost(items: any[]): any {
  let total = 0;
  for (let i = 0; i < items.length; i++) {
    total += items[i].cost;
  }
  return total;
}
```

**React Components:**
```typescript
// ✅ Good
interface PatientAvatarProps {
  patientId: string;
  size?: 'sm' | 'md' | 'lg';
}

export function PatientAvatar({ patientId, size = 'md' }: PatientAvatarProps) {
  const patient = usePatient(patientId);
  
  return (
    <div className={`avatar avatar-${size}`}>
      {patient.avatar}
    </div>
  );
}

// ❌ Bad
export function PatientAvatar(props: any) {
  const patient = usePatient(props.patientId);
  return <img src={patient.avatar} />;
}
```

**Naming Conventions:**
```typescript
// Components: PascalCase
export function PatientCard() { }

// Functions: camelCase
export function fetchPatientData() { }

// Constants: UPPER_SNAKE_CASE
export const MAX_APPOINTMENT_DURATION = 60;

// Private functions: _camelCase
function _validatePhoneNumber() { }
```

### Commit Messages

Follow conventional commits:

```
feat: Add appointment rescheduling feature
fix: Correct patient search filtering
docs: Update API documentation
test: Add tests for payment processing
refactor: Simplify dashboard component
perf: Optimize database queries
ci: Update GitHub Actions workflow

Include description after blank line:
- Explain what changed and why
- Reference issue: Closes #123
- Keep first line under 70 chars
```

### Pull Requests

**Template:**
```markdown
## Description
Brief description of what this PR does.

## Changes
- Change 1
- Change 2
- Change 3

## Testing
- [x] Tested locally
- [x] All tests passing
- [x] No TypeScript errors
- [x] No ESLint errors

## Screenshots (if UI change)
[Add screenshots of before/after]

## Breaking Changes
None / List any breaking changes

## Checklist
- [x] Code follows style guidelines
- [x] Comments added for complex logic
- [x] Documentation updated
- [x] Tests added/updated
- [x] No new warnings generated
```

---

## 🧪 Testing

### Unit Tests

```bash
# Run all tests
pnpm test

# Watch mode
pnpm test --watch

# Coverage report
pnpm test --coverage
```

**Write tests for:**
```typescript
import { describe, it, expect } from 'vitest';
import { calculateTotalCost } from '@/lib/pricing';

describe('Pricing calculations', () => {
  it('calculates total cost of multiple items', () => {
    const items = [
      { cost: 1000 },
      { cost: 2000 },
      { cost: 500 }
    ];
    
    expect(calculateTotalCost(items)).toBe(3500);
  });

  it('returns 0 for empty list', () => {
    expect(calculateTotalCost([])).toBe(0);
  });

  it('handles negative costs', () => {
    const items = [
      { cost: 1000 },
      { cost: -500 }
    ];
    
    expect(calculateTotalCost(items)).toBe(500);
  });
});
```

### Integration Tests

```bash
# Start test database
docker-compose -f docker-compose.test.yml up -d

# Run integration tests
pnpm test:integration

# Stop test database
docker-compose -f docker-compose.test.yml down
```

### API Testing

```bash
# Using test script
curl -H "Authorization: Bearer TEST_TOKEN" \
  -X GET http://localhost:3000/api/patients

# Or use API testing tool
npm install -g rest-client
# Create test.http file with requests
```

---

## 📚 Documentation

### Code Comments

```typescript
// ✅ Good - Explains WHY, not WHAT
// Patients need at least 24 hours notice to cancel without charge
// per clinic cancellation policy
if (hoursUntilAppointment < 24) {
  chargeForCancellation = true;
}

// ❌ Bad - Obvious from code
// Check if hours until appointment < 24
if (hoursUntilAppointment < 24) {
  chargeForCancellation = true;
}
```

### Documentation Files

Update relevant files when making changes:

| Change Type | Update |
|------------|--------|
| New feature | README.md, FEATURES.md, API.md |
| Bug fix | TROUBLESHOOTING.md |
| Performance | PERFORMANCE.md |
| Security | SECURITY.md |
| Deployment | DEPLOYMENT.md |
| Setup | MOBILE_SETUP.md |

---

## 🔒 Security Considerations

### Before Submitting

- [ ] No hardcoded secrets or API keys
- [ ] No sensitive data in logs
- [ ] Input validation on all user input
- [ ] SQL queries use parameterized statements
- [ ] Database queries use RLS (Row Level Security)
- [ ] No direct file access from user input
- [ ] Password hashing using bcrypt

**Security checklist:**
```typescript
// ✅ Good
const user = await db.query(
  'SELECT * FROM users WHERE email = $1',
  [email]
);

// ❌ Bad - SQL injection risk
const user = await db.query(
  `SELECT * FROM users WHERE email = '${email}'`
);
```

---

## 🎨 UI/UX Guidelines

### Accessibility (WCAG 2.1 AA)

- [ ] Proper heading hierarchy (h1 → h2 → h3)
- [ ] Button text describes action
- [ ] Color not the only indicator
- [ ] Sufficient contrast (4.5:1 for text)
- [ ] Keyboard navigation support
- [ ] Screen reader tested

### Turkish Language Support

- [ ] All UI text in Turkish
- [ ] Date format: DD.MM.YYYY
- [ ] Currency: ₺ (TRY)
- [ ] Phone format: +90 (555) 123-4567
- [ ] Number format: 1.000,00 (period for thousands)

---

## 🔄 Git Workflow

### Sync with Main

```bash
# Fetch latest changes
git fetch upstream

# Rebase your branch
git rebase upstream/main

# Or merge (preferred for PRs)
git merge upstream/main
```

### Push Changes

```bash
# Push to your fork
git push origin feat/your-feature-name

# Create Pull Request on GitHub
# - Base: zekeriyaalpyildiran-art/dentos:main
# - Compare: YOUR-USERNAME/dentos:feat/your-feature-name
```

### Resolve Conflicts

```bash
# If conflicts exist
git rebase -i upstream/main

# Resolve conflicts in editor
# Then continue
git rebase --continue

# Force push (after rebase)
git push origin feat/your-feature-name --force-with-lease
```

---

## 🚀 Before Submitting PR

### Checklist

```bash
# 1. Code quality
pnpm lint
pnpm type-check

# 2. Tests
pnpm test

# 3. Build
pnpm build

# 4. Documentation
# - README.md updated
# - Code comments clear
# - Related docs updated

# 5. Commit message
# - Descriptive and follows conventions
# - References issues/PRs

# 6. Branch
git log --oneline -5
# Verify commits are on your branch only
```

### Performance Impact

```bash
# Check bundle size change
npm run build
ls -lh .next/static/

# Benchmark database queries (if applicable)
EXPLAIN ANALYZE SELECT ...;

# Test on mobile (if UI change)
pnpm -F mobile start
```

---

## 📦 Adding Dependencies

### Before Adding

- Does it solve the problem better than existing code?
- Is it actively maintained?
- Does it have security vulnerabilities?
- Does it increase bundle size significantly?

```bash
# Check package security
npm audit
npm info package-name
npm info package-name versions

# Add dependency
pnpm add package-name

# Commit lock file
git add pnpm-lock.yaml
```

---

## 🐛 Bug Reports

**Template:**
```markdown
## Description
Brief description of the bug.

## Steps to Reproduce
1. Click on...
2. Enter...
3. Observe...

## Expected Behavior
What should happen.

## Actual Behavior
What actually happens.

## Environment
- Browser: Chrome 120
- Device: MacBook Pro
- OS: macOS 14.6

## Error Message
[Paste error from console]

## Screenshots
[Attach if applicable]
```

---

## 💡 Feature Requests

**Template:**
```markdown
## Description
Brief description of the feature.

## Use Case
Why is this needed? Who needs it?

## Proposed Solution
How should it work?

## Alternatives
Any other approaches?

## Additional Context
Screenshots, links, references.
```

---

## 🏆 Recognition

Contributors will be recognized in:

- CHANGELOG.md (next release)
- GitHub contributors page
- README.md (major contributors)

### Contribution Levels

```
🥉 Bug fixes and small improvements
🥈 New features or significant improvements
🥇 Major features, security fixes, or leadership
```

---

## 📞 Need Help?

- **Questions:** GitHub Discussions
- **Issues:** GitHub Issues
- **Security:** Email security@example.com
- **Feature Ideas:** GitHub Discussions
- **Documentation:** Create an issue or PR

---

## 🎓 Learning Resources

### Project Architecture

- `apps/web` - Next.js web application
- `apps/mobile` - React Native mobile app
- `packages/db` - Database schemas and migrations
- `packages/api` - Shared API utilities

### Key Technologies

- **Frontend:** Next.js 14, React 19, TypeScript
- **Mobile:** React Native, Expo
- **Database:** PostgreSQL, Drizzle ORM
- **State:** Zustand
- **Styling:** Tailwind CSS
- **Authentication:** JWT + OTP

### Documentation

- [README.md](./README.md) - Project overview
- [FEATURES.md](./FEATURES.md) - Feature catalog
- [API.md](./API.md) - API reference
- [DEPLOYMENT.md](./DEPLOYMENT.md) - Deployment guide
- [SECURITY.md](./SECURITY.md) - Security guidelines

---

## 📋 Code Review Process

1. **Automated Checks**
   - TypeScript type checking
   - ESLint formatting
   - Unit tests
   - Build verification

2. **Manual Review**
   - Code style and standards
   - Architecture and design
   - Security implications
   - Performance impact

3. **Feedback & Iteration**
   - Constructive comments
   - Request changes if needed
   - Approve once satisfied

---

## 🎉 Getting Your PR Merged

- ✅ All checks passing
- ✅ Code review approval
- ✅ No conflicts with main
- ✅ Documentation updated
- ✅ Tests added

Then maintainer merges and credits you!

---

**Thank you for contributing to DentOS!** 🦷✨

We appreciate your time and effort in making dental clinic management better for everyone.

---

**Last Updated:** October 7, 2026  
**Version:** 1.0.0  
**Maintained By:** DentOS Team
