/* globals describe, it, expect, jest */

const zapier = require('zapier-platform-core');

jest.mock('lenz-io', () => {
  const actual = jest.requireActual('lenz-io');
  return { ...actual, Lenz: jest.fn() };
});

const { Lenz: LenzClient } = require('lenz-io');
const App = require('../index');

const appTester = zapier.createAppTester(App);

describe('triggers.new_verification', () => {
  it('aliases verification_id to id for Zapier dedupe', async () => {
    const client = {
      verifications: {
        list: jest.fn().mockResolvedValue({
          items: [
            { verification_id: 'ab12cd34', claim: 'A', verdict: 'True', created_at: '2026-07-14T12:00:00Z' },
            { verification_id: 'ef56gh78', claim: 'B', verdict: 'False', created_at: '2026-07-14T11:00:00Z' },
          ],
          total: 2,
          page: 1,
          page_size: 20,
        }),
      },
    };
    LenzClient.mockImplementation(() => client);

    const bundle = { authData: { apiKey: 'lenz_good' } };
    const result = await appTester(App.triggers.new_verification.operation.perform, bundle);

    expect(result).toEqual([
      expect.objectContaining({ id: 'ab12cd34', verification_id: 'ab12cd34', claim: 'A' }),
      expect.objectContaining({ id: 'ef56gh78', verification_id: 'ef56gh78', claim: 'B' }),
    ]);
    expect(client.verifications.list).toHaveBeenCalledWith({ page: 1 });
  });

  it('returns an empty array when there are no verifications yet', async () => {
    const client = {
      verifications: { list: jest.fn().mockResolvedValue({ items: [], total: 0, page: 1, page_size: 20 }) },
    };
    LenzClient.mockImplementation(() => client);

    const bundle = { authData: { apiKey: 'lenz_good' } };
    const result = await appTester(App.triggers.new_verification.operation.perform, bundle);

    expect(result).toEqual([]);
  });
});
