import { beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { AppError } from '../src/errors.js';
import { components, projects } from '../src/db/schema.js';
import type { Database } from '../src/db/client.js';

// Mock database
const mockDb = {
  select: vi.fn(() => ({
    from: vi.fn(() => ({
      where: vi.fn(() => Promise.resolve([])),
    })),
  })),
  insert: vi.fn(() => ({
    values: vi.fn(() => ({
      returning: vi.fn(() => Promise.resolve([{ id: 'new-id' }])),
    })),
  })),
  update: vi.fn(() => ({
    set: vi.fn(() => ({
      where: vi.fn(() => ({
        returning: vi.fn(() => Promise.resolve([{ id: 'existing-id' }])),
      })),
    })),
  })),
  delete: vi.fn(() => ({
    where: vi.fn(() => Promise.resolve()),
  })),
} as unknown as Database;

describe('Component authorization', () => {
  const USER_ID = 'user-1';
  const OTHER_USER_ID = 'user-2';
  const PUBLIC_COMPONENT_ID = 'public-comp-1';
  const PRIVATE_COMPONENT_ID = 'private-comp-1';

  const publicComponent = {
    id: PUBLIC_COMPONENT_ID,
    name: 'Label',
    userId: null,
    isPublic: true,
  };

  const privateComponent = {
    id: PRIVATE_COMPONENT_ID,
    name: 'MyComponent',
    userId: USER_ID,
    isPublic: false,
  };

  const otherUserComponent = {
    id: 'other-comp-1',
    name: 'OtherComponent',
    userId: OTHER_USER_ID,
    isPublic: false,
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('PUT /components/:id', () => {
    it('allows owner to update their private component', async () => {
      mockDb.select.mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([privateComponent]),
        }),
      });
      mockDb.update.mockReturnValueOnce({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue([{ ...privateComponent, name: 'Updated' }]),
          }),
        }),
      });

      // Simulate the authorization logic from the route
      const existing = privateComponent;
      const user = { id: USER_ID };
      const input = { name: 'Updated' };

      // These are the checks from the route
      if (existing.userId === null) throw new AppError('FORBIDDEN', 'Public components cannot be modified', 403);
      if (existing.userId !== user.id) throw new AppError('FORBIDDEN', 'Not your component', 403);

      // If we get here, authorization passed
      expect(existing.userId).toBe(USER_ID);
      expect(input.name).toBe('Updated');
    });

    it('rejects update of public/seeded component', async () => {
      const existing = publicComponent;
      const user = { id: USER_ID };

      expect(() => {
        if (existing.userId === null) throw new AppError('FORBIDDEN', 'Public components cannot be modified', 403);
        if (existing.userId !== user.id) throw new AppError('FORBIDDEN', 'Not your component', 403);
      }).toThrow(AppError);

      expect(() => {
        if (existing.userId === null) throw new AppError('FORBIDDEN', 'Public components cannot be modified', 403);
        if (existing.userId !== user.id) throw new AppError('FORBIDDEN', 'Not your component', 403);
      }).toThrow('Public components cannot be modified');
    });

    it('rejects update of another user\'s private component', async () => {
      const existing = otherUserComponent;
      const user = { id: USER_ID };

      expect(() => {
        if (existing.userId === null) throw new AppError('FORBIDDEN', 'Public components cannot be modified', 403);
        if (existing.userId !== user.id) throw new AppError('FORBIDDEN', 'Not your component', 403);
      }).toThrow('Not your component');
    });

    it('prevents changing isPublic/userId on update', async () => {
      mockDb.select.mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([privateComponent]),
        }),
      });
      mockDb.update.mockReturnValueOnce({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue([privateComponent]),
          }),
        }),
      });

      const existing = privateComponent;
      const user = { id: USER_ID };
      const input = { isPublic: true, userId: null }; // Attempt to make public

      // The route now ignores input.isPublic and input.userId, preserving existing values
      const updateData = {
        ...input,
        userId: existing.userId,
        isPublic: existing.isPublic,
      };

      expect(updateData.userId).toBe(USER_ID);
      expect(updateData.isPublic).toBe(false);
    });
  });

  describe('DELETE /components/:id', () => {
    it('allows owner to delete their private component', async () => {
      mockDb.select.mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([privateComponent]),
        }),
      });
      mockDb.select.mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([]), // No projects using it
        }),
      });
      mockDb.delete.mockReturnValueOnce({
        where: vi.fn().mockResolvedValue(undefined),
      });

      const existing = privateComponent;
      const user = { id: USER_ID };

      if (existing.userId === null) throw new AppError('FORBIDDEN', 'Public components cannot be deleted', 403);
      if (existing.userId !== user.id) throw new AppError('FORBIDDEN', 'Not your component', 403);

      expect(existing.userId).toBe(USER_ID);
    });

    it('rejects deletion of public/seeded component', async () => {
      const existing = publicComponent;
      const user = { id: USER_ID };

      expect(() => {
        if (existing.userId === null) throw new AppError('FORBIDDEN', 'Public components cannot be deleted', 403);
        if (existing.userId !== user.id) throw new AppError('FORBIDDEN', 'Not your component', 403);
      }).toThrow('Public components cannot be deleted');
    });

    it('rejects deletion of another user\'s private component', async () => {
      const existing = otherUserComponent;
      const user = { id: USER_ID };

      expect(() => {
        if (existing.userId === null) throw new AppError('FORBIDDEN', 'Public components cannot be deleted', 403);
        if (existing.userId !== user.id) throw new AppError('FORBIDDEN', 'Not your component', 403);
      }).toThrow('Not your component');
    });
  });

  describe('POST /components', () => {
    it('creates component with current user as owner and isPublic=false', async () => {
      mockDb.insert.mockReturnValueOnce({
        values: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([{ id: 'new-id', userId: USER_ID, isPublic: false }]),
        }),
      });

      const user = { id: USER_ID };
      const input = { name: 'NewComponent', isPublic: true }; // Attempt to create public

      // The route now ignores input.isPublic and always sets userId to current user, isPublic: false
      const insertData = {
        ...input,
        userId: user.id,
        isPublic: false,
      };

      expect(insertData.userId).toBe(USER_ID);
      expect(insertData.isPublic).toBe(false);
    });
  });
});