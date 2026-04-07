import { LLMModel, Vendor, Agent, SystemAgent } from "@scheduling-agent/database";
import type { UserId } from "@scheduling-agent/types";
import { getIO } from "../../sockets/server/socketServer";
import { logger } from "../../logger";

export class ModelsService {
  async getAllModels() {
    const models = await LLMModel.findAll({
      attributes: ["id", "vendorId", "name", "slug"],
      order: [["name", "ASC"]],
    });
    const vendors = await Vendor.findAll({ attributes: ["id", "name", "slug"] });
    const vendorMap = Object.fromEntries(vendors.map((v) => [v.id, { id: v.id, name: v.name, slug: v.slug }]));
    return models.map((m) => ({
      id: m.id,
      name: m.name,
      slug: m.slug,
      vendor: vendorMap[m.vendorId] ?? null,
    }));
  }

  async getAllVendors() {
    const vendors = await Vendor.findAll({
      attributes: ["id", "name", "slug", "apiKey"],
      order: [["name", "ASC"]],
    });
    return vendors.map((v) => ({ id: v.id, name: v.name, slug: v.slug, hasApiKey: !!v.apiKey }));
  }

  async createModel(vendorId: string, name: string, slug: string, actorId: UserId) {
    const vendor = await Vendor.findByPk(vendorId);
    if (!vendor) throw Object.assign(new Error("Vendor not found."), { status: 404 });
    if (vendor.slug === "google") throw Object.assign(new Error("Google (Gemini) models cannot be added manually."), { status: 400 });

    const existingSlug = await LLMModel.findOne({ where: { slug } });
    if (existingSlug) throw Object.assign(new Error(`A model with slug "${slug}" already exists.`), { status: 409 });

    const existingName = await LLMModel.findOne({ where: { vendorId, name } });
    if (existingName) throw Object.assign(new Error(`A model named "${name}" already exists for ${vendor.name}.`), { status: 409 });

    const model = await LLMModel.create({ vendorId, name, slug });
    const result = {
      id: model.id,
      name: model.name,
      slug: model.slug,
      vendor: { id: vendor.id, name: vendor.name, slug: vendor.slug },
    };
    this.broadcast("model_created", `Model "${name}" added`, { model: result }, actorId);
    return result;
  }

  async deleteModel(modelId: string, actorId: UserId) {
    const model = await LLMModel.findByPk(modelId);
    if (!model) throw Object.assign(new Error("Model not found."), { status: 404 });

    const agentCount = await Agent.count({ where: { modelId } });
    if (agentCount > 0) {
      throw Object.assign(
        new Error(`Cannot delete — this model is in use by ${agentCount} agent(s). Switch them to a different model first.`),
        { status: 409 },
      );
    }

    const sysAgentCount = await SystemAgent.count({ where: { modelSlug: model.slug } });
    if (sysAgentCount > 0) {
      throw Object.assign(
        new Error(`Cannot delete — this model is in use by ${sysAgentCount} system agent(s).`),
        { status: 409 },
      );
    }

    const modelName = model.name;
    await model.destroy();
    this.broadcast("model_deleted", `Model "${modelName}" deleted`, { modelId }, actorId);
    return { deleted: true };
  }

  async setVendorApiKey(vendorId: string, apiKey: string | undefined, actorId: UserId) {
    const vendor = await Vendor.findByPk(vendorId);
    if (!vendor) throw Object.assign(new Error("Vendor not found."), { status: 404 });
    await vendor.update({ apiKey: apiKey || null });
    this.broadcast("vendor_api_key_updated", `API key ${apiKey ? "set" : "removed"} for ${vendor.name}`, { vendorId: vendor.id, vendorName: vendor.name, hasApiKey: !!apiKey }, actorId);
    return { id: vendor.id, name: vendor.name, slug: vendor.slug, hasApiKey: !!apiKey };
  }

  private async validateModelApiKey(modelId: string): Promise<string | null> {
    const model = await LLMModel.findByPk(modelId, { attributes: ["vendorId"] });
    if (!model) return "Model not found.";
    const vendor = await Vendor.findByPk(model.vendorId, { attributes: ["name", "apiKey"] });
    if (!vendor) return "Vendor not found.";
    if (!vendor.apiKey) return `API key not configured for ${vendor.name}. Set it in the admin panel first.`;
    return null;
  }

  private broadcast(type: string, message: string, data: Record<string, unknown>, actorId: UserId) {
    try {
      getIO().emit("admin:change", { type, message, data, actorId });
    } catch (err) {
      logger.error("broadcastAdminChange error", { error: String(err) });
    }
  }
}
