import { Router } from "express";
import * as c from "./dashboard.controller.js";

export const dashboardRouter = Router();
dashboardRouter.get("/cockpit", c.cockpit);
dashboardRouter.get("/nav-counts", c.navCounts);
dashboardRouter.get("/budget", c.budget);
dashboardRouter.get("/performance", c.performance);
dashboardRouter.get("/campaigns", c.campaigns);
dashboardRouter.get("/campaigns/:id", c.campaign);
