# Cloudflare Agentic Coding Sessions Platform

## Executive Summary

Build a platform that enables long-running agentic coding sessions using Cloudflare's serverless infrastructure. Users trigger the system with a task prompt, the platform authenticates them, spins up a containerized OpenCode agent, executes the task with user-provided credentials, validates the results, and records a proof-of-work video. All state management, authentication, and orchestration happens through Cloudflare's platform.

## Platform Vision

The goal is to create a scalable, secure, and production-ready platform that allows users to delegate coding tasks to an authenticated AI agent running in a controlled container environment. The platform must:

- Authenticate users and their credentials securely
- Execute tasks through containerized OpenCode instances
- Use the user's actual subscriptions (OpenAI, Anthropic, GitHub, etc.)
- Record proof-of-work through video capture
- Provide real-time monitoring and validation
- Handle long-running sessions with proper resource management

## High-Level Architecture

### Core Components

```
User Interface → Workers Orchestrator → Container Management → OpenCode Agent → Validation & Recording
       ↓                  ↓                      ↓                        ↓                      ↓
 Authentication    Session State          Credential Injection      Task Execution        Video Output
```

### Component Breakdown

#### 1. User Interface Layer

**Purpose**: The entry point for user interaction

**Responsibilities**:

- Provide web dashboard for task submission
- Display real-time session status and progress
- Show validation results and video playback
- Handle user authentication (platform-level)
- Manage session history and archives

**User Flow**:

1. User logs into the platform (platform authentication)
2. User submits task prompt via dashboard or API
3. User's credentials are configured (OAuth or API key management)
4. User views real-time progress and validation status
5. User reviews and watches proof-of-work video upon completion

#### 2. Platform Authentication Layer

**Purpose**: Secure user authentication for the platform itself

**Mechanism**: User tokens or OAuth

**Key Decisions**:

- Platform authentication separates from agent authentication
- Users authenticate with the platform to access services
- Token-based authentication for scalability
- Session management with expiration and refresh
- Role-based access control for different user tiers

**Security Model**:

- Tokens validated on every request
- Short-lived tokens with refresh capability
- Audit trail for all platform access
- Rate limiting per user
- Secure token storage and transmission

#### 3. Credential Management System

**Purpose**: Securely manage user's API credentials for agent authentication

**Architecture**:

- Centralized credential storage (Cloudflare Secrets Store)
- Per-session credential injection
- Secure credential rotation
- Role-based access to user credentials
- Credential lifecycle management

**Credential Types**:

- OpenAI API key
- Anthropic API key
- GitHub personal access token
- Other LLM provider API keys
- Optional: Cloudflare Workers AI access

**Security Considerations**:

- Credentials encrypted at rest
- Only accessible by agent containers during execution
- No credential exposure in logs or telemetry
- Automatic credential rotation support
- Per-session credential isolation

#### 4. Container Orchestrator

**Purpose**: Manage container lifecycle and task execution

**Architecture**:

- Cloudflare Containers platform integration
- Container lifecycle management (start, stop, restart)
- Container health monitoring
- Error recovery and retry logic

**Container Capabilities**:

- Full Linux filesystem access
- Network connectivity to external services
- GPU support (optional for AI tasks)
- Screen recording capabilities
- Process isolation and resource limits

**Lifecycle Management**:

- Container provisioning with pre-warming
- Automatic scaling based on load
- Graceful shutdown on completion or error
- Resource cleanup and session isolation
- Container state persistence during execution

#### 5. OpenCode Agent Integration

**Purpose**: Execute coding tasks using authenticated OpenCode instances

**Authentication Flow**:

- User's credentials injected into container environment
- OpenCode loads credentials from environment or config
- Agent authenticated with user's subscriptions
- Session-based authentication for AI providers

**Task Execution Model**:

- Non-interactive execution mode
- Session-based operation with persistent context
- Tool execution (file operations, code execution)
- Git integration for repository access
- LLM-powered coding capabilities

**Execution Modes**:

- Plan-first approach (review before implementing)
- Direct implementation mode
- Iterative refinement based on validation
- Undo/redo capability for changes

#### 6. Session Orchestration

**Purpose**: Manage the complete session lifecycle from start to finish

**Session Lifecycle**:

1. **Initialization**: Create session record, initialize container, inject credentials
2. **Execution**: Monitor agent progress, handle interruptions, track token usage
3. **Validation**: Run validation checks, collect results
4. **Recording**: Capture screen session, generate proof-of-work video
5. **Completion**: Cleanup resources, update session status, provide results
6. **Archival**: Store session artifacts and videos for review

**State Management**:

- Session state stored in D1 database
- Real-time status updates via WebSocket
- Task progress tracking and estimation
- Token usage monitoring and cost estimation
- Error handling and retry logic

#### 7. Validation System

**Purpose**: Ensure task completion correctness

**Validation Approaches**:

- Automated validation checks (tests, linter, type checking)
- Human-in-the-loop validation (optional review)
- Output validation (format, content, structure)
- Integration testing capability
- Diff comparison against expected output

**Validation Stages**:

- Pre-execution: Task analysis and planning
- During execution: Progress monitoring and checkpoints
- Post-execution: Output validation and quality checks
- Final validation: User acceptance and verification

#### 8. Video Recording System

**Purpose**: Capture proof-of-work by recording agent execution

**Recording Capabilities**:

- Screen capture of OpenCode terminal
- Audio capture for explanation narration
- Real-time video compression
- Session timestamping and annotations
- Playback synchronization with execution

**Technical Approach**:

- Video capture via ffmpeg or similar tools
- Container-level recording (X11/Wayland)
- Progressive recording (save as session progresses)
- Smart compression for storage efficiency
- Automatic cleanup after session completion

#### 9. Storage Layer

**Purpose**: Store session state, logs, and artifacts

**Components**:

- D1 Database: Session metadata, user records, task state
- R2 Storage: Video recordings, session artifacts, logs
- KV Store: Temporary caching, rate limiting, session data
- Secrets Store: User credentials and platform secrets

**Storage Strategy**:

- Strong consistency for session state (D1)
- S3-compatible object storage for videos (R2)
- Eventual consistency for cache and metadata (KV)
- Automated lifecycle management
- Multi-region distribution for performance

## Authentication Architecture

### Platform Authentication (Separate from Agent Auth)

**Purpose**: Secure user access to the platform itself

**Mechanism**: Token-based authentication

**Flow**:

1. User logs in via web interface
2. Platform generates authentication token
3. Token includes user ID, email, scopes, expiration
4. Token stored securely and validated on each request
5. Token passed to container for session identification

**Security**:

- HMAC-SHA256 signed tokens
- Short expiration (1-2 hours) with refresh capability
- Scope-based authorization
- Audit logging for all platform access
- Rate limiting per user

### Agent Authentication (User Credentials)

**Purpose**: Enable OpenCode to use user's actual subscriptions

**Mechanism**: Credential injection into container environment

**Credential Types**:

- OpenAI API key
- Anthropic API key
- GitHub personal access token
- Other LLM provider API keys
- Optional: Cloudflare Workers AI access

**Security Model**:

- Credentials stored encrypted in Secrets Store
- Only accessible by container during session execution
- No credential exposure in logs or telemetry
- Per-session credential isolation
- Automatic credential rotation support

**Alternative: OpenCode Native Authentication**

**Flow**:

1. User runs `opencode auth login` locally
2. User adds credentials for all providers
3. Credentials stored in `~/.local/share/opencode/auth.json`
4. User shares auth file with platform
5. Platform mounts auth file into container
6. OpenCode loads credentials automatically

**Trade-offs**:

- Native authentication: Simpler user setup, relies on file mounting
- Environment injection: More secure, works better with containers

## Data Flow and Communication

### User Request Flow

1. **Authentication**:
   - User sends authenticated request to Workers API
   - Token validated and user context extracted
   - User ID and permissions verified

2. **Session Initialization**:
   - Session record created in D1 database
   - Unique session ID generated
   - Resource allocation initiated

3. **Container Provisioning**:
   - Container orchestrator receives session request
   - Container instance selected (cold start or warm)
   - Environment variables and credentials injected

4. **Task Execution**:
   - OpenCode agent receives prompt and credentials
   - Agent authenticates with user's subscriptions
   - Task execution begins with monitoring

5. **Real-time Monitoring**:
   - WebSocket connection established for progress updates
   - Token usage tracked and reported
   - Task progress estimated and displayed
   - Errors and interruptions handled

6. **Validation**:
   - Output validated against requirements
   - Automated tests executed (optional)
   - Human review triggered if needed

7. **Recording**:
   - Screen session captured during execution
   - Video compressed and stored
   - Timestamps and annotations added

8. **Completion**:
   - Container shut down and cleaned up
   - Session status updated to "complete"
   - Video URL and results returned to user
   - Resources deallocated

## Session Lifecycle Details

### Phase 1: Initialization

**Activities**:

- Session metadata stored in D1
- Unique session ID generated
- Container slot reserved
- Credentials prepared and injected
- WebSocket connection established

**Timeouts and Limits**:

- Maximum session duration (configurable)
- Minimum required resources
- Startup time expectations
- Error recovery triggers

### Phase 2: Execution

**Activities**:

- Agent authenticates and loads credentials
- Task execution begins
- Real-time progress updates streamed
- Token usage monitored
- Output saved and validated

**Monitoring**:

- CPU/memory usage tracking
- Token consumption rate monitoring
- Task progress estimation
- Error detection and recovery
- Auto-retry logic for transient failures

### Phase 3: Validation

**Activities**:

- Output format validated
- Functional tests executed
- Code quality checks run
- Integration tests performed (optional)
- Human review triggered if automated checks fail

**Decision Points**:

- Success: Proceed to recording
- Partial Success: Show user for manual review
- Failure: Provide error details, offer retry or abort

### Phase 4: Recording

**Activities**:

- Screen recording started before task begins
- Execution captured in real-time
- Video compressed during or after recording
- Annotations and timestamps added
- Video stored in R2

**Quality Considerations**:

- Resolution and frame rate
- Audio quality (optional)
- Compression efficiency
- Storage space management
- Playback performance

### Phase 5: Completion and Cleanup

**Activities**:

- Video uploaded to R2
- Session status finalized
- Results and video URL returned to user
- Resources deallocated
- Session archived for future reference

**Cleanup**:

- Container stopped and destroyed
- Temporary files deleted
- Credentials invalidated
- Session records archived
- Resource quotas reset

## Security Architecture

### Platform Security

**Authentication**:

- Token-based authentication
- HMAC-SHA256 signed tokens
- Short expiration with refresh
- Scope-based authorization
- Secure token transmission

**Authorization**:

- Role-based access control
- Per-user quotas and limits
- Resource allocation limits
- API rate limiting
- IP and session restrictions

**Data Protection**:

- All data encrypted at rest
- Data in transit encrypted (HTTPS)
- Secrets stored in encrypted vaults
- No sensitive data in logs
- Audit trails for compliance

### Agent and Credential Security

**Credential Isolation**:

- Per-session credential access
- No credential sharing between sessions
- No credential caching after session
- Automatic credential invalidation
- Secure credential destruction

**Container Security**:

- Isolated execution environment
- Resource limits enforced
- Network access controlled
- File system sandboxed
- Process isolation enforced

**Execution Security**:

- Input validation on all inputs
- Output validation and sanitization
- Execution timeout enforcement
- Error handling and recovery
- Safe tool execution

### Audit and Compliance

**Audit Trail**:

- All session activities logged
- User actions tracked
- Resource usage monitored
- Security events recorded
- Compliance reporting ready

**Data Retention**:

- Session logs retained (configurable)
- Videos retained per policy
- Audit data retained per compliance
- Automatic cleanup of old data

## Performance and Scalability

### Horizontal Scaling

**Container Scaling**:

- Auto-scaling based on request volume
- Container pre-warming for reduced latency
- Geographic distribution for low latency
- Load balancing across container instances
- Resource reservation for peak loads

### Vertical Scaling

**Resource Management**:

- CPU cores allocated per container
- Memory limits enforced
- GPU support for AI tasks
- Network bandwidth management
- Storage I/O optimization

### Caching and Optimization

**Caching Strategy**:

- Container image caching
- Provider model caching
- Dependency pre-fetching
- CDN for video delivery
- Database query optimization

### Latency Considerations

**Cold Start Management**:

- Container pre-warming and caching
- Geographic proximity optimization
- Resource reservation
- Start-time monitoring and improvement
- Fallback strategies for critical paths

**Session Startup Optimization**:

- Credential pre-loading
- Environment preparation
- Tool initialization
- Connection pooling
- Dependency pre-fetching

## User Experience Design

### Dashboard Features

**Session Management**:

- Create new session
- View session history
- Monitor current sessions
- Access session archives
- Share sessions with team

**Real-time Monitoring**:

- Live progress tracking
- Token usage visualization
- Estimated completion time
- Error notifications
- Status indicators

**Results View**:

- Task completion summary
- Validation results
- Video playback
- Diff comparison
- Log access

### Interaction Patterns

**Session Creation**:

- Simple prompt input
- Optional project context
- Configuration options
- Quick-start templates
- Project-specific settings

**During Execution**:

- Progress updates
- Token consumption display
- Completion estimation
- Manual intervention option
- Cancel/abort capability

**After Completion**:

- Automatic validation
- Video playback
- User feedback collection
- Session sharing
- Archive access

## Cost Management

### Resource Costs

**Container Costs**:

- Per-instance-hour pricing
- Instance type selection
- Auto-scaling optimization
- Idle container management
- Resource over-provisioning control

**Storage Costs**:

- Video storage (R2)
- Database storage (D1)
- Cache storage (KV)
- Object storage (R2)
- Lifecycle management

**API Costs**:

- LLM provider API calls
- AI gateway usage
- External API calls
- Token consumption tracking
- Usage-based billing

### Cost Optimization

**Optimization Strategies**:

- Session timeout enforcement
- Resource reservation tuning
- Video compression optimization
- Caching and reuse
- Load-based scaling

**Cost Monitoring**:

- Real-time cost tracking
- Per-user cost limits
- Cost alerts and notifications
- Usage reporting and analysis
- Budget enforcement

## Technical Decisions and Rationale

### Why Cloudflare?

**Benefits**:

- Serverless architecture with no infrastructure management
- Global edge deployment for low latency
- Built-in container platform for long-running tasks
- Secrets Store for secure credential management
- Strong consistency for state management
- Comprehensive monitoring and observability

**Alternatives Considered**:

- AWS ECS/Fargate: More infrastructure management, less developer-friendly
- Docker Swarm: Not cloud-native, less scalable
- Kubernetes: Overkill for this use case, high complexity
- Traditional VMs: Not serverless, management overhead

### Why OpenCode?

**Capabilities**:

- Terminal-based interface for automation
- Supports 75+ LLM providers
- Built-in tool execution
- Git integration
- Session-based context
- Open source and extensible

**Alternatives Considered**:

- AutoGPT: Less structured, harder to control
- other coding agents: Less mature, fewer integrations

### Why Cloudflare Workflows?

**Benefits**:

- Durable execution for long-running sessions
- Automatic retries and error handling
- Event-based continuation
- Built-in observability
- Cost-effective for multi-step tasks

**Alternative Considered**:

- Container-only: Less observability, no automatic retries

### Why Secrets Store?

**Benefits**:

- Encrypted at rest
- Centralized management
- Audit trail
- Easy rotation
- Container-friendly
- Cloudflare-native

**Alternative Considerened**:

- Environment variables only: Less secure, no audit trail
- File-based secrets: Less secure, harder to manage

### Why R2 for Video?

**Benefits**:

- S3-compatible API
- No egress fees
- High scalability
- Global CDN
- Cost-effective for large files

**Alternative Considered**:

- D1: Not designed for video storage, cost-prohibitive
- KV: Value size limits, not suitable for videos
- External S3: Egress fees, additional complexity

### Why D1 for State?

**Benefits**:

- Strong consistency
- SQL queries
- Time Travel for backups
- Worker and HTTP API access
- Row-level security

**Alternative Considered**:

- KV: Eventual consistency, less query support
- External DB: Single point of failure, more complexity

## Implementation Phases

### Phase 1: Core Infrastructure

**Goal**: Establish foundational platform components

**Milestones**:

- Platform authentication system
- Secrets Store integration
- Basic Workers API
- D1 database schema
- R2 storage setup
- Container infrastructure

### Phase 2: Session Management

**Goal**: Enable basic session creation and execution

**Milestones**:

- Session lifecycle orchestration
- Container provisioning
- Credential injection
- Basic task execution
- Simple validation
- Basic monitoring

### Phase 3: Advanced Features

**Goal**: Add validation and recording capabilities

**Milestones**:

- Validation system
- Video recording
- Real-time monitoring
- Error recovery
- User dashboard
- API integration

### Phase 4: Production Readiness

**Goal**: Optimize for production use

**Milestones**:

- Performance optimization
- Security hardening
- Cost optimization
- Monitoring and alerting
- CI/CD pipeline
- Comprehensive testing

### Phase 5: User Experience

**Goal**: Deliver polished user experience

**Milestones**:

- Dashboard UI
- Real-time progress updates
- Video playback
- Session sharing
- User feedback
- Documentation and tutorials

## Success Metrics

### Platform Metrics

- Session success rate
- Average session duration
- Container utilization
- API response times
- Error rates
- Uptime and availability

### User Metrics

- User adoption rate
- Session completion rate
- User satisfaction score
- Time saved vs manual coding
- Feature adoption

### Financial Metrics

- Cost per session
- Revenue per session
- ROI calculation
- Cost optimization progress
- Profit margins

## Risks and Mitigations

### Technical Risks

- **Container cold starts**: Pre-warming, regional optimization
- **Credential security**: Strong encryption, isolation, rotation
- **Resource exhaustion**: Limits, monitoring, auto-scaling
- **Session failures**: Retry logic, error handling, validation

### Operational Risks

- **Platform downtime**: Redundancy, monitoring, fallback
- **Cost overruns**: Budget enforcement, optimization
- **Data loss**: Backup strategy, time travel
- **Security breaches**: Monitoring, audit, incident response

### User Experience Risks

- **Slow startup**: Optimization, pre-warming
- **Poor validation**: Improvements, human review
- **Bad videos**: Quality control, encoding optimization
- **Unsatisfying results**: Feedback, iteration

## Future Enhancements

### Short-term

- Advanced validation (fuzzing, security scans)
- Multi-session coordination
- Collaborative editing
- Session templates
- API-first design

### Medium-term

- Human-in-the-loop approval workflows
- Custom agent development
- Advanced analytics
- Integration with CI/CD
- Team collaboration features

### Long-term

- Multi-agent workflows
- Autonomous project management
- Predictive session planning
- Custom tool development
- Marketplace for agents and tools

## Conclusion

This platform enables secure, scalable, and automated coding through authenticated AI agents running in containerized environments. By leveraging Cloudflare's serverless infrastructure, we achieve:

- **Security**: Encrypted credentials, isolated containers, comprehensive audit trails
- **Scalability**: Auto-scaling containers, global distribution, resource optimization
- **Reliability**: Built-in retries, error handling, strong consistency
- **User Experience**: Real-time monitoring, video proof-of-work, simple interface
- **Cost-effectiveness**: Optimized resource usage, no egress fees, pay-per-use

The architecture separates platform authentication from agent authentication, uses Secrets Store for secure credential management, and leverages Cloudflare's native services for orchestration, storage, and monitoring. OpenCode provides the foundation for intelligent, authenticated coding tasks with video proof-of-work.

This platform transforms the way developers work by enabling trusted, automated coding sessions that can be validated, audited, and shared - providing confidence in AI-assisted development at scale.
